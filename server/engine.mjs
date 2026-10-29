import { notificationSelection } from "../shared/notification-preferences.ts";
import {
  cycleSummary,
  cycleDetails,
  dailySummary,
} from "../shared/notifications.ts";
import { randomUUID } from "node:crypto";
import {
  decide,
  zoned,
  usageOver,
  schedule,
  clockDue,
  thresholdTransition,
} from "./policy.mjs";
import { errorText } from "./aliyun.mjs";
import { BillingService } from "./billing.mjs";
import { resourceKey } from "./store.mjs";
export class Engine {
  constructor(store, gateway, service, jobs, notify) {
    Object.assign(this, { store, gateway, service, jobs, notify });
    this.owner = randomUUID();
    this.timers = [];
    this.policyRunning = false;
    this.paused = false;
    this.startedAt = Date.now();
    this.billing = new BillingService(store, gateway, service, notify);
    this.lastCycle = 0;
    this.lastMonth = "";
  }
  lease() {
    const now = Date.now(),
      body = JSON.stringify({ owner: this.owner, expires: now + 90000 });
    return !!this.store.db
      .prepare(
        "INSERT INTO entities(kind,id,body) VALUES('lease','engine',?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body WHERE json_extract(entities.body,'$.expires')<? OR json_extract(entities.body,'$.owner')=?",
      )
      .run(body, now, this.owner).changes;
  }
  start() {
    const every = (fn, ms) => {
      const tick = () => {
        if (!this.paused && this.lease())
          fn().catch((e) =>
            this.store.put("health", "lastError", {
              at: Date.now(),
              error: errorText(e),
            }),
          );
      };
      const timer = setInterval(tick, ms);
      timer.unref();
      this.timers.push(timer);
      return tick;
    };
    const jobs = every(async () => {
      this.jobs.tick();
      this.notify.tick();
    }, 5000);
    const policy = every(() => this.cycle(), 60000);
    const reports = every(() => this.reports(), 60000);
    every(async () => this.store.prune(), 86400000);
    jobs();
    policy();
    reports();
    this.store.onClose.add(() => this.stop());
  }
  stop() {
    this.paused = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
  async cycle(force = false, filter = {}) {
    if (this.cyclePromise) {
      if (force) {
        await this.cyclePromise;
        return this.cycle(true, filter);
      }
      return;
    }
    this.cyclePromise = this.runCycle(force, filter);
    try {
      return await this.cyclePromise;
    } finally {
      this.cyclePromise = undefined;
    }
  }
  hasTargets(filter = {}) {
    return this.store
      .accounts()
      .some(
        (a) =>
          (!filter.accountId ||
            filter.accountId === "all" ||
            a.id === filter.accountId) &&
          (!a.monitors ||
            a.monitors.some(
              (m) =>
                !filter.region ||
                filter.region === "all" ||
                m.region === filter.region,
            )),
      );
  }
  async runCycle(force = false, filter = {}) {
    if (this.policyRunning) return;
    if (!this.hasTargets(filter)) {
      if (!this.hasTargets()) {
        this.lastCycle = 0;
        this.lastMonth = "";
      }
      return;
    }
    const month = zoned(new Date(), "Asia/Shanghai").month;
    const scheduledDue = this.store.list("rule").some((r) => {
      if (
        !r.scheduleEnabled ||
        r.paused ||
        !this.store.accounts().some((a) => a.id === r.accountId)
      )
        return false;
      const time = schedule(r, new Date());
      const previous = this.store.get("health", "monitor:" + resourceKey(r));
      const cached = this.store
        .get("scope", JSON.stringify([r.accountId, r.region]))
        ?.items?.find((i) => i.id === r.id);
      return (
        previous?.scheduleToken !== time.token ||
        (time.startPending && cached?.status === "Stopped" && !r.hold) ||
        (!time.allowed && cached?.status === "Running")
      );
    });
    if (
      !force &&
      !scheduledDue &&
      month === this.lastMonth &&
      Date.now() - this.lastCycle < this.store.settings().checkInterval * 1000
    )
      return;
    if (
      (!filter.accountId || filter.accountId === "all") &&
      (!filter.region || filter.region === "all")
    ) {
      this.lastCycle = Date.now();
      this.lastMonth = month;
    }
    this.policyRunning = true;
    const startedAt = Date.now(),
      results = [];
    try {
      // A cold/legacy database needs discovery once. Subsequent polls reuse the
      // same DescribeInstances response for status and network metadata, so no
      // independent discovery timer can bypass the configured check interval.
      if (!this.service.scopes().some((s) => s.items.length))
        await this.service.refresh(filter);
      else await this.service.statusCycle(filter);
      for (const i of this.service.instances(filter).items) {
        let rule = this.store.rule(i);
        const now = Date.now(),
          traffic = usageOver(rule, i.usage, now);
        const thresholdKey = "threshold:" + resourceKey(i);
        const threshold = thresholdTransition(
          this.store.get("health", thresholdKey),
          rule,
          i.usage,
          now,
        );
        let released = false;
        if (
          rule.hold === "traffic" &&
          rule.thresholdEnabled &&
          rule.autoRecover &&
          !rule.paused &&
          traffic.valid &&
          !traffic.over
        ) {
          this.store.progress(i, {
            hold: undefined,
            reason: "流量已恢复安全，重新检查运行规则",
          });
          rule = this.store.rule(i);
          released = true;
        }
        this.store.put("health", thresholdKey, threshold.state);
        if (threshold.event === "threshold")
          this.notify.event(
            thresholdKey + ":" + threshold.state.sequence,
            "流量阈值告警",
            `已达到 ${rule.thresholdUnit === "gib" ? rule.thresholdGiB + " GB" : rule.thresholdPercent + "%"}，${rule.thresholdAction === "stop" ? "按保护规则关机" : "仅通知"}`,
            {
              level: "warning",
              instance: { name: i.name, region: i.region, usage: i.usage },
            },
          );
        if (threshold.event === "recovery" || released) {
          const reason =
            rule.hold === "traffic"
              ? "流量已低于阈值，自动恢复未开启，继续保持停机"
              : "流量已低于阈值，按保活与定时规则重新检查";
          this.notify.event(
            "traffic-recovery:" + randomUUID(),
            "流量保护恢复",
            reason,
            { instance: { name: i.name, region: i.region, usage: i.usage } },
          );
          this.store.audit({
            action: "traffic-recovery",
            category: "automation",
            target: i.name,
            detail: reason,
            context: {
              instanceId: i.id,
              region: i.region,
              usage: i.usage,
              autoRecover: rule.autoRecover,
              released,
            },
          });
        }
        const d = decide(i, rule, this.store.settings(), {
          now,
          busy: !!this.jobs.busy(i),
          statusFresh:
            !!i.statusAt && now - i.statusAt < 70000 && !i.statusError,
        });
        if (d.action && this.jobs.controlBackoff(i)) {
          d.action = undefined;
          d.source = undefined;
          d.scheduleKey = undefined;
          d.reason = "云端权限或安全限制，等待冷却后按当前规则重试";
        }
        this.store.progress(i, {
          lastCheck: new Date(now).toISOString(),
          reason: d.reason,
          ...(d.latch ? { hold: "traffic" } : {}),
        });
        results.push({
          id: i.id,
          name: i.name,
          accountId: i.accountId,
          accountName: i.accountName,
          region: i.region,
          status: i.status,
          statusAt: i.statusAt,
          usage: i.usage,
          billing: i.billing,
          keepAlive: i.effectiveKeepAlive,
          paused: rule.paused,
          hold: this.store.rule(i).hold,
          stoppedMode: rule.stoppedMode || "KeepCharging",
          thresholdEnabled: rule.thresholdEnabled,
          threshold:
            rule.thresholdUnit === "gib"
              ? rule.thresholdGiB + " GB"
              : rule.thresholdPercent + "%",
          thresholdAction: rule.thresholdAction,
          scheduleEnabled: rule.scheduleEnabled,
          start: rule.start,
          stop: rule.stop,
          timezone: rule.timezone,
          decision: d.action || "none",
          execution: d.action ? "queued" : "none",
          source: d.source,
          reason: d.reason,
          error: i.statusError || i.usage?.error,
        });
        if (d.action) {
          try {
            const job = this.jobs.enqueue(i, d.action, d.source, {
              revision: rule.revision,
              scheduleKey: d.scheduleKey,
              stoppedMode: rule.stoppedMode || "KeepCharging",
            });
            results.at(-1).jobId = job.id;
            results.at(-1).execution = job.status;
          } catch (e) {
            results.at(-1).error = errorText(e);
            results.at(-1).execution = "failed";
            this.store.progress(i, { reason: errorText(e) });
          }
        }
        const previous = this.store.get("health", "monitor:" + resourceKey(i));
        const error = i.statusError || i.usage?.error || undefined;
        const signature = error
          ? error.replace(/[a-f0-9-]{20,}/gi, "...").slice(0, 100)
          : "";
        if (signature && previous?.error !== signature)
          this.notify.event(
            "monitor-error:" + randomUUID(),
            "检测异常",
            errorText(error).slice(0, 160),
            { level: "error", instance: { name: i.name, region: i.region } },
          );
        else if (!signature && previous?.error)
          this.notify.event(
            "monitor-recovery:" + randomUUID(),
            "检测恢复",
            "查询已恢复，按当前规则继续监控",
            { instance: { name: i.name, region: i.region } },
          );
        else if (
          previous &&
          previous.status !== i.status &&
          !i.job &&
          !signature &&
          now - Date.parse(rule.lastAction || 0) > 120000
        )
          this.notify.event(
            "status:" + randomUUID(),
            "实例状态变化",
            `${previous.status} → ${i.status}`,
            { instance: { name: i.name, region: i.region } },
          );
        this.store.put("health", "monitor:" + resourceKey(i), {
          status: i.status,
          error: signature,
          scheduleToken: rule.scheduleEnabled
            ? schedule(rule, new Date(now)).token
            : undefined,
        });
        const time = schedule(rule, new Date(now));
        if (
          time.startPending &&
          i.status === "Running" &&
          !rule.hold &&
          !d.action &&
          !signature
        )
          this.store.progress(i, { lastSchedule: time.key });
      }
      if (notificationSelection(this.store.settings()).includes("cycle")) {
        const errors = results.filter((i) => i.error).length;
        this.notify.event(
          "cycle:" + randomUUID(),
          "检测完成",
          cycleDetails(results),
          { kind: "cycle", level: errors ? "error" : "info" },
        );
      }
      this.store.audit({
        action: "monitor-cycle",
        category: "monitor",
        level: results.some((r) => r.error) ? "error" : "info",
        status: results.some((r) => r.error) ? "failed" : "success",
        target: results.length + " 台实例",
        detail: cycleSummary(this.service.instances(filter).items),
        context: {
          source: force ? "manual" : "automatic",
          durationMs: Date.now() - startedAt,
          resources: results,
        },
      });
      this.store.put("health", "engine", { at: Date.now(), owner: this.owner });
      // Sampling runs after control decisions and never delays protection jobs.
      void this.service.captureTraffic().catch((e) => {
        if (!this.service.closed)
          this.store.put("health", "traffic-error", {
            at: Date.now(),
            error: errorText(e),
          });
      });
    } catch (e) {
      this.store.audit({
        action: "monitor-cycle",
        category: "monitor",
        level: "error",
        status: "failed",
        detail: errorText(e),
        context: {
          source: force ? "manual" : "automatic",
          durationMs: Date.now() - startedAt,
          resources: results,
        },
      });
      throw e;
    } finally {
      this.policyRunning = false;
    }
  }
  async reports() {
    if (this.reportRunning) return;
    this.reportRunning = true;
    try {
      await this.reportCycle();
    } finally {
      this.reportRunning = false;
    }
  }
  async reportCycle() {
    if (!this.hasTargets()) return;
    const startedAt = new Date();
    if (this.store.settings().billingEnabled) await this.billing.refresh();
    const settings = this.store.settings(),
      now = new Date(),
      local = zoned(now, settings.timezone);
    if (
      !notificationSelection(settings).includes("daily") ||
      !(
        clockDue(now, settings.timezone, settings.reportTime) ||
        (zoned(startedAt, settings.timezone).date === local.date &&
          clockDue(startedAt, settings.timezone, settings.reportTime))
      )
    )
      return;
    const items = this.service.instances().items;
    if (!items.length) return;
    const message = dailySummary(
      items,
      this.billing.view().items,
      settings.billingEnabled,
    );
    this.notify.event(
      "report:" + local.date,
      "Aliyun 实例日报 " + local.date,
      message,
      { kind: "report" },
    );
  }
}
