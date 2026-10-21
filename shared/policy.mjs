// Reuse ICU formatters across polling, billing and DST compensation checks.
const formatters = new Map();
function timeFormatters(timezone) {
  let hit = formatters.get(timezone);
  if (hit) formatters.delete(timezone);
  else
    hit = {
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
      clock: new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    };
  formatters.set(timezone, hit);
  if (formatters.size > 32) formatters.delete(formatters.keys().next().value);
  return hit;
}
export function zoned(now, timezone) {
  const p = Object.fromEntries(
    timeFormatters(timezone)
      .date.formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    clock: `${p.hour}:${p.minute}`,
    month: `${p.year}-${p.month}`,
  };
}
export const inWindow = (clock, start, stop) =>
  start < stop
    ? clock >= start && clock < stop
    : clock >= start || clock < stop;
export function clockDue(now, timezone, clock) {
  const local = zoned(now, timezone);
  const minutes = (s) => +s.slice(0, 2) * 60 + +s.slice(3);
  if ((minutes(local.clock) - minutes(clock) + 1440) % 1440 < 10) return true;
  // Compensate for a configured local time skipped by daylight saving time.
  for (let minute = 1; minute <= 10; minute++) {
    const previous = zoned(Number(new Date(now)) - minute * 60000, timezone);
    if (
      previous.date === local.date &&
      previous.clock < clock &&
      local.clock >= clock
    )
      return true;
  }
  return false;
}
export function schedule(rule, now) {
  const local = zoned(now, rule.timezone);
  const allowed =
    !rule.scheduleEnabled ||
    rule.scheduleStopEnabled === false ||
    inWindow(local.clock, rule.start, rule.stop);
  const startDue =
    rule.scheduleEnabled && clockDue(now, rule.timezone, rule.start);
  const cycleDate =
    rule.scheduleStopEnabled !== false &&
    rule.start > rule.stop &&
    local.clock < rule.start
      ? new Date(Date.parse(local.date + "T00:00:00Z") - 86400000)
          .toISOString()
          .slice(0, 10)
      : local.date;
  const key = cycleDate + ":" + rule.start;
  return {
    ...local,
    allowed,
    startDue,
    key,
    token: JSON.stringify([
      rule.timezone,
      rule.start,
      rule.stop,
      rule.scheduleStopEnabled !== false,
      allowed,
      key,
    ]),
    startPending:
      !!rule.scheduleEnabled &&
      allowed &&
      rule.lastSchedule !== key &&
      (rule.scheduleStopEnabled !== false || startDue),
  };
}
export function usageOver(rule, usage, now = Date.now()) {
  if (!rule.thresholdEnabled) return { valid: true, over: false };
  const valid =
    !!usage &&
    !usage.error &&
    usage.quota === "finite" &&
    Number.isFinite(usage.used) &&
    usage.used >= 0 &&
    Number.isFinite(usage.total) &&
    usage.total > 0 &&
    now - usage.at >= 0 &&
    now - usage.at <= 300000 &&
    zoned(new Date(usage.at), "Asia/Shanghai").month ===
      zoned(new Date(now), "Asia/Shanghai").month;
  return {
    valid,
    over:
      valid &&
      (rule.thresholdUnit === "gib"
        ? usage.used >= rule.thresholdGiB * 1024 ** 3
        : (usage.used / usage.total) * 100 >= rule.thresholdPercent),
  };
}
export function thresholdTransition(previous, rule, usage, now = Date.now()) {
  const traffic = usageOver(rule, usage, now);
  const old = previous || { active: false, sequence: 0 };
  if (!rule.thresholdEnabled) return { state: { ...old, active: false } };
  if (!traffic.valid) return { state: old };
  const month = zoned(new Date(now), "Asia/Shanghai").month;
  const configuration = JSON.stringify([
    rule.thresholdUnit,
    rule.thresholdPercent,
    rule.thresholdGiB,
    rule.thresholdAction,
  ]);
  const crossing =
    traffic.over &&
    (!old.active || old.month !== month || old.configuration !== configuration);
  return {
    state: {
      active: traffic.over,
      month,
      configuration,
      sequence: (old.sequence || 0) + (crossing ? 1 : 0),
    },
    event: crossing
      ? "threshold"
      : old.active && !traffic.over
        ? "recovery"
        : undefined,
  };
}
export function decide(
  instance,
  rule,
  settings,
  { now = Date.now(), busy = false, statusFresh = true } = {},
) {
  const time = schedule(rule, new Date(now)),
    traffic = usageOver(rule, instance.usage, now),
    keep = rule.keepAlive ?? settings.keepAliveDefault;
  if (instance.locked) return { reason: "实例被云端锁定，禁止自动操作" };
  if (rule.paused) return { reason: "自动化已暂停" };
  if (!statusFresh) return { reason: "实例状态查询失败，等待更新" };
  if (["Disabled", "Unknown"].includes(instance.status) || !instance.status)
    return { reason: "实例不可用" };
  if (instance.expires && new Date(instance.expires).getTime() <= now)
    return { reason: "实例已到期，保活暂停" };
  if (
    busy ||
    ["Pending", "Starting", "Stopping", "Resetting", "Upgrading"].includes(
      instance.status,
    )
  )
    return { reason: "正在处理实例操作" };
  if (
    rule.hold === "traffic" &&
    !(
      rule.thresholdEnabled &&
      rule.autoRecover &&
      traffic.valid &&
      !traffic.over
    )
  )
    return {
      reason: "流量保护已触发，等待恢复",
      action: instance.status === "Running" ? "stop" : undefined,
      source: "traffic",
    };
  if (traffic.over)
    return {
      reason:
        rule.thresholdAction === "stop"
          ? "达到流量阈值"
          : "达到阈值，仅告警，禁止自动开机",
      notify: true,
      ...(rule.thresholdAction === "stop" && rule.hold !== "manual"
        ? { latch: true }
        : {}),
      action:
        rule.thresholdAction === "stop" && instance.status === "Running"
          ? "stop"
          : undefined,
      source: "traffic",
    };
  if (!time.allowed)
    return {
      reason: "当前处于定时停机时段",
      action: instance.status === "Running" ? "stop" : undefined,
      source: "schedule",
    };
  if (rule.hold === "manual") return { reason: "手动停机，禁止自动启动" };
  if (!traffic.valid) return { reason: "CDT 流量不可用，禁止自动开机" };
  if (instance.status === "Stopped" && (keep || time.startPending))
    return {
      reason: time.startPending ? "准备定时开机" : "意外停止，准备保活启动",
      action: "start",
      source: time.startPending ? "schedule" : "keepalive",
      ...(time.startPending ? { scheduleKey: time.key } : {}),
    };
  return {
    reason: keep
      ? "保活已启用"
      : rule.scheduleEnabled
        ? "定时开关机已启用"
        : "保活未启用",
  };
}
export function nextSchedule(rule, now) {
  const current = schedule(rule, now);
  // Search real minutes so DST gaps and repeated local hours remain accurate.
  const base = Math.floor(now.getTime() / 60000) * 60000;
  const formatter = timeFormatters(rule.timezone).clock;
  for (let minute = 1; minute <= 60 * 49; minute++) {
    const at = base + minute * 60000;
    const clock = formatter.format(at);
    const allowed = inWindow(clock, rule.start, rule.stop);
    if (
      rule.scheduleStopEnabled === false
        ? clock === rule.start
        : allowed !== current.allowed
    )
      return {
        allowed: current.allowed,
        nextAction:
          rule.scheduleStopEnabled === false || allowed ? "start" : "stop",
        nextAt: new Date(at).toISOString(),
      };
  }
  return undefined;
}
