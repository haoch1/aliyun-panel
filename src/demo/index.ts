import {
  defaultNotificationTypes,
  notificationSelection,
  wantsNotification,
} from "../../shared/notification-preferences.ts";
import { commonRegions } from "../../shared/regions.ts";
import type {
  Account,
  Instance,
  Job,
  Rule,
  Settings,
} from "../../shared/types";
import {
  decide,
  nextSchedule,
  usageOver,
  zoned,
  schedule,
  clockDue,
  thresholdTransition,
} from "../../shared/policy.mjs";
import {
  cycleDetails,
  dailySummary,
  operationTitle,
} from "../../shared/notifications.ts";
import type { NotificationMessage } from "../../shared/notifications.ts";

// Demo is loaded only by ?demo=1. It never calls fetch or a cloud SDK.
const GiB = 1024 ** 3,
  uid = () => crypto.randomUUID(),
  now = () => Date.now();
const baseRule = (accountId: string, region: string, id: string): Rule => ({
  accountId,
  region,
  id,
  keepAlive: null,
  paused: false,
  thresholdEnabled: false,
  thresholdPercent: 90,
  thresholdUnit: "percent",
  thresholdGiB: 180,
  autoRecover: false,
  stoppedMode: "KeepCharging",
  scheduleStopEnabled: true,
  thresholdAction: "stop",
  scheduleEnabled: false,
  start: "08:00",
  stop: "23:00",
  timezone: "Asia/Shanghai",
  reason: "保活未开启",
});
let accounts: Account[] = [
  {
    id: "demo-main",
    name: "香港生产环境",
    cloudAccountId: "100000000001",
    principalId: "demo-user",
    site: "china",
    region: "cn-hongkong",
    keyTail: "DEMO",
    accessKeyId: "DEMO-ACCESSKEY-CN",
    accessStatus: "readable",
  },
  {
    id: "demo-intl",
    name: "新加坡应用",
    cloudAccountId: "100000000002",
    principalId: "demo-intl-user",
    site: "international",
    region: "ap-southeast-1",
    keyTail: "DEMO",
    accessKeyId: "DEMO-ACCESSKEY-INTL",
    accessStatus: "readable",
  },
];
let settings: Settings = {
  keepAliveDefault: true,
  billingEnabled: true,
  checkInterval: 60,
  billingInterval: 3600,
  dailyReport: true,
  reportTime: "00:00",
  timezone: "Asia/Shanghai",
  notifications: {
    telegramEnabled: true,
    telegramToken: "",
    telegramChatId: "",
    events: [...defaultNotificationTypes],
    apiBase: "https://api.telegram.org",
  },
};
let counter = 0;
function makeInstance(
  accountId: string,
  region: string,
  id: string,
  name: string,
  status: string,
  used: number,
  total: number,
): Instance {
  return {
    accountId,
    accountName: accounts.find((a) => a.id === accountId)?.name || "示例账户",
    region,
    id,
    name,
    status,
    ip: ["192.0.2." + (18 + counter++)],
    privateIp: ["10.0.0.18"],
    planId: "ecs.t6-c1m2.large",
    product: "ecs",
    chargeType: "PostPaid",
    internetChargeType: "PayByTraffic",
    spotStrategy: "NoSpot",
    cpu: 2,
    memory: 2,
    disk: 40,
    expires: new Date(now() + 86400000 * 120).toISOString(),
    created: new Date(now() - 86400000 * 30).toISOString(),
    usage: {
      used: used * GiB,
      total: total * GiB,
      remaining: (total - used) * GiB,
      overflow: 0,
      quota: "finite",
      scope: "account",
      pool:
        region.startsWith("cn-") && region !== "cn-hongkong"
          ? "china"
          : "international",
      at: now(),
    },
    rule: baseRule(accountId, region, id),
    effectiveKeepAlive: false,
  };
}
let instances: Instance[] = [
  makeInstance(
    "demo-main",
    "cn-hongkong",
    "demo-web",
    "hongkong-web",
    "Running",
    64.8,
    200,
  ),
  makeInstance(
    "demo-main",
    "cn-hongkong",
    "demo-backup",
    "backup-server",
    "Stopped",
    64.8,
    200,
  ),
  makeInstance(
    "demo-intl",
    "ap-southeast-1",
    "demo-api",
    "singapore-api",
    "Running",
    182.4,
    200,
  ),
];
instances[0].rule.keepAlive = true;
instances[1].rule.keepAlive = true;
instances[1].rule.hold = "manual";
instances[2].rule.thresholdEnabled = true;
// Match the seeded detection log without running any actions during page loading.
for (const i of instances) {
  i.rule.reason = decide(i, i.rule, settings).reason;
  i.rule.lastCheck = new Date(now() - 60000).toISOString();
}
accounts.forEach(
  (a) =>
    (a.monitors = instances
      .filter((i) => i.accountId === a.id)
      .map((i) => ({ id: i.id, region: i.region }))),
);
let jobs: Job[] = [];
let billAt = now();
let refreshAt = now();
let lastCycleAt = now();
const bills: Record<string, number> = {
  "demo-web": 48,
  "demo-backup": 24,
  "demo-api": 4.5,
};
function billingSnapshot(i: Instance) {
  return settings.billingEnabled
    ? {
        amount: bills[i.id] ?? 12,
        currency:
          accounts.find((a) => a.id === i.accountId)?.site === "international"
            ? "USD"
            : "CNY",
        at: billAt,
        stale: false,
      }
    : undefined;
}
let logs: any[] = [
  {
    id: uid(),
    at: now() - 60000,
    action: "monitor-cycle",
    target: "3 台实例",
    category: "monitor",
    level: "info",
    status: "success",
    detail: "3 台 · 运行 2 · 暂停 0 · 异常 0",
    context: {
      source: "automatic",
      durationMs: 842,
      resources: instances.map((i) => ({
        id: i.id,
        name: i.name,
        accountId: i.accountId,
        accountName: i.accountName,
        region: i.region,
        status: i.status,
        statusAt: now() - 60000,
        usage: structuredClone(i.usage),
        billing: billingSnapshot(i),
        stoppedMode: i.rule.stoppedMode || "KeepCharging",
        scheduleEnabled: i.rule.scheduleEnabled,
        start: i.rule.start,
        stop: i.rule.stop,
        timezone: i.rule.timezone,
        keepAlive: i.rule.keepAlive ?? settings.keepAliveDefault,
        paused: i.rule.paused,
        hold: i.rule.hold,
        thresholdEnabled: i.rule.thresholdEnabled,
        threshold:
          i.rule.thresholdUnit === "gib"
            ? i.rule.thresholdGiB + " GB"
            : i.rule.thresholdPercent + "%",
        thresholdAction: i.rule.thresholdAction,
        reason: decide(i, i.rule, settings).reason,
        decision: "none",
      })),
    },
  },
  {
    id: uid(),
    at: now() - 300000,
    action: "billing-refresh",
    target: "香港生产环境",
    category: "billing",
    level: "info",
    status: "success",
    detail: "账单与余额查询完成",
    context: {
      accountName: "香港生产环境",
      site: "china",
      cycle: zoned(new Date(), "Asia/Shanghai").month,
      balanceStatus: "success",
      billStatus: "success",
      availableAmount: 128.5,
      currency: "CNY",
      balanceAt: now() - 300000,
      billAt: now() - 300000,
      durationMs: 613,
      rows: 2,
    },
  },
  {
    id: uid(),
    at: now() - 900000,
    action: "notification-sent",
    target: "香港 Web",
    category: "notification",
    level: "info",
    status: "success",
    detail: "保活开机 · 已发送",
    context: {
      title: "保活开机",
      attempts: 1,
      content: "✅ 保活开机\n香港 Web\n已确认实例运行",
    },
  },
  {
    id: uid(),
    at: now() - 1800000,
    action: "keepalive-start",
    target: "demo-web",
    category: "automation",
    level: "info",
    status: "success",
    detail: "已确认实例运行",
    context: {
      instanceName: "香港 Web",
      region: "cn-hongkong",
      source: "keepalive",
      phase: "success",
      before: "Stopped",
      expected: "Running",
      actual: "Running",
      completedAt: now() - 1795000,
    },
  },
  {
    id: uid(),
    at: now() - 3600000,
    action: "billing-refresh",
    target: "香港生产环境",
    category: "billing",
    level: "warning",
    status: "failed",
    detail: "余额：请求超时；已保留上次成功数据",
    context: {
      accountName: "香港生产环境",
      cycle: zoned(new Date(), "Asia/Shanghai").month,
      balanceStatus: "failed",
      billStatus: "success",
      retainedCache: true,
      durationMs: 15000,
    },
  },
];
let notifications: any[] = [];
const scans = new Map<string, { data: any; items: any[] }>();
function identity(t: any) {
  return JSON.stringify([t.accountId, t.region, t.id]);
}
function find(t: any) {
  const i = instances.find((i) => identity(i) === identity(t));
  if (!i) throw new Error("找不到示例实例");
  return i;
}
function changed() {
  window.dispatchEvent(new Event("demo-changed"));
}
function audit(
  action: string,
  target: string,
  detail: string,
  options: any = {},
) {
  logs.unshift({
    id: uid(),
    at: now(),
    action,
    target,
    status: "success",
    detail,
    category: /keepalive|traffic|schedule/.test(action)
      ? "automation"
      : /notification/.test(action)
        ? "notification"
        : /billing/.test(action)
          ? "billing"
          : action === "monitor-cycle"
            ? "monitor"
            : "operation",
    level: "info",
    ...structuredClone(options),
  });
}
function notify(
  title: string,
  message: string,
  level = "info",
  force = false,
  metadata: Partial<NotificationMessage> = {},
) {
  const n = settings.notifications;
  if (
    !n.telegramEnabled ||
    !n.telegramToken ||
    !n.telegramChatId ||
    (!force && !wantsNotification(settings, { title, level, ...metadata }))
  )
    return;
  notifications.unshift({
    id: uid(),
    at: now(),
    channel: "telegram",
    status: "sent",
    title,
    message,
    attempts: 1,
    level,
    ...metadata,
  });
  return true;
}
function enqueue(
  i: Instance,
  action: string,
  source = "manual",
  apply?: () => void,
) {
  if (
    jobs.some(
      (j) =>
        j.accountId === i.accountId &&
        j.region === i.region &&
        j.instanceId === i.id &&
        ["queued", "submitted", "attention"].includes(j.status),
    )
  )
    throw new Error("实例正在处理中");
  const j: Job = {
    id: uid(),
    accountId: i.accountId,
    region: i.region,
    instanceId: i.id,
    action,
    source,
    status: "queued",
    at: now(),
    updatedAt: now(),
    detail: "等待模拟执行",
  };
  const before = i.status;
  jobs.unshift(j);
  setTimeout(() => {
    j.status = "submitted";
    j.updatedAt = now();
    changed();
  }, 300);
  setTimeout(() => {
    try {
      apply?.();
      i.status = action === "stop" ? "Stopped" : "Running";
      i.rule.lastAction = new Date().toISOString();
      j.status = "success";
      j.detail = "模拟" + (action === "stop" ? "关机" : "开机") + "成功";
      audit(source + "-" + action, i.id, j.detail, {
        context: {
          instanceName: i.name,
          accountName: i.accountName,
          region: i.region,
          source,
          phase: "success",
          before,
          expected: action === "stop" ? "Stopped" : "Running",
          actual: i.status,
          completedAt: now(),
        },
      });
      notify(
        operationTitle(source, action),
        action === "stop" ? "已确认实例停止" : "已确认实例运行",
        "info",
        false,
        {
          instance: {
            name: i.name,
            region: i.region,
            ...(source === "traffic" ? { usage: i.usage } : {}),
          },
        },
      );
    } catch (e) {
      j.status = "failed";
      j.detail = (e as Error).message;
    }
    j.updatedAt = now();
    changed();
  }, 1000);
  changed();
  return j;
}
const thresholdStates = new Map<string, any>();
const scheduleTokens = new Map<string, string>();
const reportDates = new Set<string>();
const instanceKey = (i: Instance) =>
  JSON.stringify([i.accountId, i.region, i.id]);
function policy(items = instances) {
  for (const i of items) {
    i.statusAt = now();
    if (i.usage) i.usage.at = now();
    const r = i.rule;
    const traffic = usageOver(r, i.usage);
    const transition = thresholdTransition(
      thresholdStates.get(instanceKey(i)),
      r,
      i.usage,
    );
    thresholdStates.set(instanceKey(i), transition.state);
    if (transition.event === "threshold")
      notify(
        "流量阈值告警",
        `已达到 ${r.thresholdUnit === "gib" ? r.thresholdGiB + " GB" : r.thresholdPercent + "%"}，${r.thresholdAction === "stop" ? "按保护规则关机" : "仅通知"}`,
        "warning",
        false,
        { instance: { name: i.name, region: i.region, usage: i.usage } },
      );
    if (
      r.thresholdEnabled &&
      !r.paused &&
      r.autoRecover &&
      r.hold === "traffic" &&
      traffic.valid &&
      !traffic.over
    )
      r.hold = undefined;
    if (transition.event === "recovery")
      notify(
        "流量保护恢复",
        r.hold === "traffic"
          ? "流量已低于阈值，自动恢复未开启，继续保持停机"
          : "流量已低于阈值，按保活与定时规则重新检查",
        "info",
        false,
        { instance: { name: i.name, region: i.region, usage: i.usage } },
      );
    i.effectiveKeepAlive = r.keepAlive ?? settings.keepAliveDefault;
    i.schedule = r.scheduleEnabled ? nextSchedule(r, new Date()) : undefined;
    const busy = jobs.some(
      (j) =>
        j.accountId === i.accountId &&
        j.instanceId === i.id &&
        ["queued", "submitted", "attention"].includes(j.status),
    );
    const d = decide(i, r, settings, { busy });
    r.reason = d.reason;
    r.lastCheck = new Date().toISOString();
    if (d.latch) r.hold = "traffic";
    if (d.action && !busy)
      enqueue(i, d.action, d.source, () => {
        if (d.scheduleKey) (r as any).lastSchedule = d.scheduleKey;
      });
    const time = schedule(r, new Date());
    scheduleTokens.set(instanceKey(i), time.token);
    if (time.startPending && i.status === "Running" && !r.hold && !d.action)
      r.lastSchedule = time.key;
  }
}
function checkRules(source: "manual" | "automatic", filter?: URLSearchParams) {
  const startedAt = now();
  const items = filter ? listInstances(filter).map(find) : instances;
  if (!items.length) return;
  if (
    !filter ||
    ((!filter.get("accountId") || filter.get("accountId") === "all") &&
      (!filter.get("region") || filter.get("region") === "all"))
  )
    lastCycleAt = now();
  policy(items);
  if (notificationSelection(settings).includes("cycle"))
    notify(
      "检测完成",
      cycleDetails(
        items.map((i) => {
          const job = jobs.find(
            (j) =>
              j.accountId === i.accountId &&
              j.instanceId === i.id &&
              ["queued", "submitted"].includes(j.status),
          );
          return {
            ...i,
            billing: billingSnapshot(i),
            decision: job?.action,
            source: job?.source,
          };
        }),
      ),
      "info",
      false,
      { kind: "cycle" },
    );
  audit("monitor-cycle", items.length + " 台实例", "实例检测完成", {
    category: "monitor",
    context: {
      source,
      durationMs: now() - startedAt,
      resources: items.map((i) => ({
        id: i.id,
        name: i.name,
        accountId: i.accountId,
        accountName: i.accountName,
        region: i.region,
        status: i.status,
        statusAt: i.statusAt,
        usage: structuredClone(i.usage),
        billing: billingSnapshot(i),
        stoppedMode: i.rule.stoppedMode || "KeepCharging",
        scheduleEnabled: i.rule.scheduleEnabled,
        start: i.rule.start,
        stop: i.rule.stop,
        timezone: i.rule.timezone,
        keepAlive: i.rule.keepAlive ?? settings.keepAliveDefault,
        paused: i.rule.paused,
        hold: i.rule.hold,
        thresholdEnabled: i.rule.thresholdEnabled,
        threshold:
          i.rule.thresholdUnit === "gib"
            ? i.rule.thresholdGiB + " GB"
            : i.rule.thresholdPercent + "%",
        thresholdAction: i.rule.thresholdAction,
        reason: i.rule.reason,
        decision:
          jobs.find(
            (j) =>
              j.accountId === i.accountId &&
              j.region === i.region &&
              j.instanceId === i.id &&
              ["queued", "submitted", "attention"].includes(j.status),
          )?.action || "none",
      })),
    },
  });
  changed();
}
// Automatic checks use their own clock; only an explicit refresh with check=true also runs rules.
export function startDemoAutomation() {
  const timer = setInterval(() => {
    const scheduledDue = instances.some((i) => {
      if (!i.rule.scheduleEnabled || i.rule.paused) return false;
      const time = schedule(i.rule, new Date());
      return (
        scheduleTokens.get(instanceKey(i)) !== time.token ||
        (time.startPending && i.status === "Stopped" && !i.rule.hold) ||
        (!time.allowed && i.status === "Running")
      );
    });
    if (scheduledDue || now() - lastCycleAt >= settings.checkInterval * 1000)
      checkRules("automatic");
    const local = zoned(new Date(), settings.timezone);
    if (
      instances.length > 0 &&
      notificationSelection(settings).includes("daily") &&
      !reportDates.has(local.date) &&
      clockDue(new Date(), settings.timezone, settings.reportTime)
    ) {
      if (
        notify(
          "Aliyun 实例日报 " + local.date,
          dailySummary(
            listInstances(new URLSearchParams()),
            billing(local.month, "all").items,
            settings.billingEnabled,
          ),
          "info",
          false,
          { kind: "report" },
        )
      )
        reportDates.add(local.date);
    }
  }, 1000);
  return () => clearInterval(timer);
}
function listInstances(q: URLSearchParams) {
  return instances
    .filter(
      (i) =>
        (!q.get("accountId") ||
          q.get("accountId") === "all" ||
          i.accountId === q.get("accountId")) &&
        (!q.get("region") ||
          q.get("region") === "all" ||
          i.region === q.get("region")),
    )
    .map((i) => ({
      ...i,
      effectiveKeepAlive: i.rule.keepAlive ?? settings.keepAliveDefault,
      schedule: i.rule.scheduleEnabled
        ? nextSchedule(i.rule, new Date())
        : undefined,
      billing: {
        amount: bills[i.id] ?? 12,
        currency:
          accounts.find((a) => a.id === i.accountId)?.site === "international"
            ? "USD"
            : "CNY",
        at: billAt,
        stale: false,
      },
      job: jobs.find(
        (j) =>
          j.accountId === i.accountId &&
          j.instanceId === i.id &&
          ["queued", "submitted", "attention"].includes(j.status),
      ),
    }));
}
function billing(cycle: string, accountId = "all") {
  return {
    cycle,
    items: accounts
      .filter((a) => accountId === "all" || a.id === accountId)
      .map((a) => {
        const currency = a.site === "international" ? "USD" : "CNY";
        const own = instances
          .filter((i) => i.accountId === a.id)
          .map((i) => ({
            id: i.id,
            name: i.name,
            region: i.region,
            amount: bills[i.id] ?? 12,
          }));
        return {
          accountId: a.id,
          accountName: a.name,
          site: a.site,
          cycle,
          currency,
          at: billAt,
          checkedAt: billAt,
          stale: false,
          refreshing: false,
          balance: {
            availableAmount: currency === "USD" ? 36.8 : 128.5,
            currency,
          },
          balanceAt: billAt,
          instances: own,
          items: own.map((i) => ({
            instanceID: i.id,
            pretaxAmount: i.amount,
            currency,
          })),
        };
      }),
  };
}
export async function demoApi(
  path: string,
  body: any,
  method: string,
): Promise<any> {
  const u = new URL(path, "http://demo.local"),
    p = u.pathname,
    q = u.searchParams,
    t = Object.fromEntries(q);
  await new Promise((resolve) => setTimeout(resolve, 100));
  let result: any;
  if (p === "/auth")
    result = {
      initialized: true,
      authenticated: true,
      csrf: "demo",
      expires: now() + 86400000,
      demo: true,
    };
  else if (p === "/logout") {
    location.href = "/";
    result = { ok: true };
  } else if (p === "/session")
    result = { expires: now() + (body.hours || 720) * 3600000, csrf: "demo" };
  else if (p === "/accounts" && method === "GET") result = { items: accounts };
  else if (p === "/connections/regions") result = { items: commonRegions };
  else if (p === "/connections/discover") {
    if (!body.accessKeyId || !body.accessKeySecret)
      throw new Error("请填写 AccessKey ID 和 Secret");
    if (!body.name?.trim() || !body.instanceId?.trim())
      throw new Error("实例名称和实例 ID 必填");
    if (!/^i-[\w-]+$/.test(body.instanceId))
      throw new Error("请填写 ECS 实例 ID（i- 开头）");
    const region =
      body.region ||
      (body.site === "international" ? "ap-southeast-1" : "cn-hongkong");
    const items = [
      {
        id: body.instanceId,
        name: "discovered-web",
        region,
        status: /backup|found-2/.test(body.instanceId) ? "Stopped" : "Running",
        ip: ["192.0.2.88"],
      },
    ];
    const token = uid();
    scans.set(token, { data: structuredClone(body), items });
    result = { token, items, errors: [], regions: commonRegions };
  } else if (p === "/connections/import") {
    const scan = scans.get(body.token);
    if (!scan) throw new Error("请重新发现实例");
    const selected = scan.items.filter((i) =>
      body.targets.some((t: any) => t.id === i.id && t.region === i.region),
    );
    if (!selected.length) throw new Error("请选择实例");
    const data = scan.data;
    let a = accounts.find(
      (a) => a.accessKeyId === data.accessKeyId && a.site === data.site,
    );
    if (!a) {
      a = {
        id: uid(),
        name: "阿里云账号 · 100000000003",
        region: selected[0].region,
        site: data.site,
        cloudAccountId: "100000000003",
        principalId: "demo",
        keyTail: "DEMO",
        accessKeyId: data.accessKeyId,
        accessStatus: "readable",
        monitors: [],
      };
      accounts.push(a);
    }
    let added = 0;
    for (const item of selected)
      if (
        !instances.some(
          (i) =>
            i.accountId === a!.id &&
            i.region === item.region &&
            i.id === item.id,
        )
      ) {
        const i = makeInstance(
          a.id,
          item.region,
          item.id,
          body.targets.find(
            (t: any) => t.id === item.id && t.region === item.region,
          )?.name || item.name,
          item.status,
          12,
          200,
        );
        const shared = instances.find(
          (x) => x.accountId === a!.id && x.usage?.pool === i.usage?.pool,
        );
        if (shared?.usage) i.usage = { ...shared.usage };
        i.rule.keepAlive = body.keepAlive ?? null;
        instances.push(i);
        a.monitors!.push({ id: i.id, region: i.region, name: i.name });
        added++;
      }
    scans.delete(body.token);
    audit("monitor-add", a.name, "添加示例监控 " + added + " 台已有实例");
    result = { added, existing: selected.length - added, accountId: a.id };
    changed();
  } else if (/^\/connections\/[^/]+$/.test(p)) {
    const a = accounts.find((a) => a.id === p.split("/")[2]);
    if (!a) throw new Error("示例账户不存在");
    if (method === "GET") result = { ...a, secretConfigured: true };
    else if (method === "PUT") {
      Object.assign(a, {
        name: body.name,
        site: body.site,
        region: body.region,
        accessKeyId: body.accessKeyId,
      });
      if (body.instance) {
        const i = find(body.instance.target);
        if (i.accountId !== a.id) throw new Error("实例与账号不匹配");
        i.name = body.instance.name;
      }
      instances
        .filter((i) => i.accountId === a.id)
        .forEach((i) => (i.accountName = a.name));
      audit("connection-update", a.name, "示例凭证已更新");
      result = { ok: true };
      changed();
    } else throw new Error("不支持此操作");
  } else if (p === "/monitors" && method === "DELETE") {
    const i = find(body);
    instances = instances.filter((x) => identity(x) !== identity(i));
    const a = accounts.find((a) => a.id === i.accountId)!;
    a.monitors = a.monitors?.filter(
      (x) => x.id !== i.id || x.region !== i.region,
    );
    if (!instances.some((x) => x.accountId === a.id))
      accounts = accounts.filter((x) => x.id !== a.id);
    audit("monitor-remove", i.name, "已移除本地示例监控");
    result = { ok: true };
    changed();
  } else if (p === "/regions")
    result = {
      items: [
        { regionId: "cn-hongkong", localName: "中国香港" },
        { regionId: "cn-hangzhou", localName: "华东 1（杭州）" },
        { regionId: "cn-shanghai", localName: "华东 2（上海）" },
        { regionId: "ap-southeast-1", localName: "新加坡" },
      ],
    };
  else if (p === "/instances")
    result = {
      items: listInstances(q),
      at: refreshAt,
      errors: [],
      refreshing: false,
    };
  else if (p === "/refresh") {
    refreshAt = now();
    for (const i of listInstances(new URLSearchParams(body))) {
      const stored = find(i);
      stored.statusAt = refreshAt;
      if (stored.usage) stored.usage.at = refreshAt;
    }
    if (body.check) checkRules("manual", new URLSearchParams(body));
    result = { ok: true };
    changed();
  } else if (p === "/check") {
    checkRules("manual");
    result = { ok: true };
  } else if (p === "/keepalive" && method === "PUT") {
    if (![null, true, false].includes(body.keepAlive))
      throw new Error("保活设置无效");
    const i = find(body.target);
    i.rule.keepAlive = body.keepAlive;
    i.rule.revision = uid();
    audit(
      "keepalive-update",
      i.id,
      "保活设置：" +
        (body.keepAlive === null
          ? "跟随全局默认"
          : body.keepAlive
            ? "单独开启"
            : "单独关闭"),
      {
        context: { instanceName: i.name, region: i.region, rule: i.rule },
      },
    );
    result = i.rule;
    changed();
  } else if (
    ["/rules", "/rules/traffic", "/rules/schedule"].includes(p) &&
    method === "PUT"
  ) {
    const i = find(body.target);
    Object.assign(i.rule, body.rule, { revision: uid() });
    audit("rule-update", i.id, "示例运行规则已保存", {
      context: { instanceName: i.name, region: i.region, rule: i.rule },
    });
    result = i.rule;
    changed();
  } else if (p === "/operations") {
    const i = find(body),
      action = body.action;
    if (!["start", "stop", "resume"].includes(action))
      throw new Error("此操作已移除");
    if (action !== "stop") {
      const rule = {
        ...i.rule,
        hold: undefined,
        paused: false,
        keepAlive: true,
      };
      const d = decide({ ...i, status: "Stopped" }, rule, settings);
      if (d.action !== "start" && !body.override)
        throw new Error(d.reason + "，请先修改流量保护或定时设置");
      result = enqueue(i, "start", "manual", () => {
        i.rule.hold = undefined;
        i.rule.paused = !!body.override;
      });
    } else
      result = enqueue(i, "stop", "manual", () => {
        i.rule.hold = "manual";
      });
  } else if (p === "/traffic") {
    const trafficInstance = find(t);
    trafficInstance.usage!.at = now();
    const days =
      q.get("days") === "month"
        ? Number(zoned(new Date(), "Asia/Shanghai").date.slice(-2))
        : Number(q.get("days") || 7);
    result = {
      items: Array.from({ length: days }, (_, n) => ({
        date: new Date(now() - n * 86400000).toISOString().slice(0, 10),
        outBytes: (1.8 + Math.sin(n) * 0.6) * GiB,
        inBytes: (0.8 + Math.cos(n) * 0.2) * GiB,
        flowBytes: (2.6 + Math.sin(n) * 0.6 + Math.cos(n) * 0.2) * GiB,
        inPoints: 24,
        outPoints: 24,
      })),
      errors: [],
      usage: trafficInstance.usage,
      start: now() - days * 86400000,
      end: now(),
      timezone: "Asia/Shanghai",
      checkedAt: now(),
    };
  } else if (p === "/jobs" && method === "GET") result = { items: jobs };
  else if (/^\/jobs\/[^/]+\/recheck$/.test(p)) {
    const j = jobs.find((j) => j.id === p.split("/")[2]);
    if (j) j.status = "success";
    result = { ok: true };
    changed();
  } else if (p === "/settings") {
    if (method === "PUT") {
      const old = settings.notifications,
        n = body.notifications;
      settings = {
        ...settings,
        ...body,
        keepAliveDefault: true,
        notifications: {
          telegramEnabled: n.telegramEnabled,
          telegramChatId: n.telegramChatId,
          mode: n.mode,
          ...(Array.isArray(n.events)
            ? { events: notificationSelection({ notifications: n }) }
            : {}),
          apiBase: n.apiBase,
          telegramToken: n.telegramToken || old.telegramToken,
        },
      };
      settings.dailyReport = notificationSelection(settings).includes("daily");
      audit("settings-update", "面板", "演示设置已更新");
      changed();
    }
    result = {
      ...settings,
      notifications: {
        ...settings.notifications,
        mode: undefined,
        events: notificationSelection(settings),
        telegramToken: "",
        telegramConfigured: !!settings.notifications.telegramToken,
      },
    };
  } else if (p === "/notifications/test") {
    notify("TG 通知测试", "演示通知已模拟发送，不访问 Telegram", "info", true);
    result = { channels: notifications.length ? ["telegram"] : [] };
    audit("notification", "面板", "已模拟 TG 通知");
    changed();
  } else if (p === "/notifications")
    result = { items: notifications, at: now() };
  else if (p === "/billing")
    result = billing(
      q.get("cycle") || zoned(new Date(), "Asia/Shanghai").month,
      q.get("accountId") || "all",
    );
  else if (p === "/billing/refresh") {
    billAt = now();
    audit(
      "billing-refresh",
      body.accountId || "全部账户",
      "账单与余额查询完成",
      {
        category: "billing",
        context: {
          cycle: body.cycle,
          billAt,
          balanceAt: billAt,
          source: "manual",
        },
      },
    );
    result = billing(
      body.cycle || zoned(new Date(), "Asia/Shanghai").month,
      body.accountId || "all",
    );
    changed();
  } else if (p === "/audit") {
    if (method === "DELETE") logs = [];
    result = { items: logs, at: now() };
  } else throw new Error("此操作需连接真实面板；演示模式不会访问真实接口");
  return structuredClone(result);
}
