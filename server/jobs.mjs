import { randomUUID } from "node:crypto";
import { errorText } from "./aliyun.mjs";
import { decide, usageOver, schedule } from "./policy.mjs";
import { operationTitle } from "../shared/notifications.ts";
import { resourceKey } from "./store.mjs";
export class Jobs {
  constructor(store, gateway, service, notify) {
    Object.assign(this, { store, gateway, service, notify });
    this.running = new Set();
  }
  public(j) {
    const { secretPayload, secretResult, ...safe } = j;
    return { ...safe, hasResult: !!secretResult };
  }
  busy(t) {
    return this.store
      .list("job")
      .find(
        (j) =>
          j.accountId === t.accountId &&
          j.region === t.region &&
          j.instanceId === t.id &&
          ["queued", "submitted", "attention"].includes(j.status),
      );
  }
  controlBackoff(t) {
    const state = this.store.get("health", "control:" + resourceKey(t));
    return state?.retryAt > Date.now() ? state : undefined;
  }
  enqueue(t, action, source, payload = {}) {
    if (!["start", "stop"].includes(action)) throw new Error("此功能已移除");
    if (source !== "manual" && this.controlBackoff(t))
      throw new Error("云端权限或安全限制，等待冷却后按当前规则重试");
    const id = randomUUID();
    if (this.busy(t)) {
      const e = new Error("该实例有未完成操作，请先查看操作进度");
      e.status = 409;
      throw e;
    }
    const at = Date.now();
    const auditId = this.store.audit({
      account: t.accountId,
      action: source + "-" + action,
      target: t.id,
      status: "submitted",
      detail: "等待提交",
      category: source === "manual" ? "operation" : "automation",
      context: {
        source,
        region: t.region,
        instanceName: this.service.instance(t)?.name,
        accountName: this.store.account(t.accountId).name,
        jobId: id,
        phase: "queued",
        rule: this.store.rule(t),
        stoppedMode:
          action === "stop" ? payload.stoppedMode || "KeepCharging" : undefined,
        before: this.service.instance(t)?.status,
      },
    });
    const job = {
      id,
      accountId: t.accountId,
      region: t.region,
      instanceId: t.id,
      action,
      source,
      status: "queued",
      at,
      updatedAt: at,
      clientToken: id,
      auditId,
      secretPayload: this.store.encrypt(payload),
    };
    this.store.put("job", id, job);
    return this.public(job);
  }
  finish(j, status, detail, result) {
    j = {
      ...j,
      status,
      updatedAt: Date.now(),
      detail,
      ...(result ? { result } : {}),
    };
    this.store.put("job", j.id, j);
    this.store.updateAudit(j.auditId, {
      status: status === "attention" ? "submitted" : status,
      detail,
      context: {
        phase: status,
        completedAt: Date.now(),
        requestId: j.requestId,
        expected: j.action === "start" ? "Running" : "Stopped",
        actual: this.service.instance({
          accountId: j.accountId,
          region: j.region,
          id: j.instanceId,
        })?.status,
      },
    });
    if (["success", "failed", "attention"].includes(status))
      this.notify.event(
        "job:" + j.id + ":" + status,
        operationTitle(j.source, j.action),
        detail,
        {
          level: status === "success" ? "info" : "error",
          instance: {
            region: j.region,
            usage:
              j.source === "traffic"
                ? this.service.instance({
                    accountId: j.accountId,
                    region: j.region,
                    id: j.instanceId,
                  })?.usage
                : undefined,
            name:
              this.service.instance({
                accountId: j.accountId,
                region: j.region,
                id: j.instanceId,
              })?.name || j.instanceId,
          },
        },
      );
    return j;
  }
  async manual(
    t,
    action,
    { override = false, stoppedMode = "KeepCharging" } = {},
  ) {
    if (this.busy(t))
      throw Object.assign(new Error("实例有未完成操作，请先核对"), {
        status: 409,
      });
    if (action === "stop")
      this.store.saveRule(t, {
        hold: "manual",
        reason: "手动停机，禁止自动启动",
      });
    const normalized = action === "resume" ? "start" : action;
    const i = await this.service.refreshTarget(t, {
      usage: normalized === "start" && this.store.rule(t).thresholdEnabled,
    });
    if (normalized === "start") {
      const rule = this.store.rule(t),
        traffic = usageOver(rule, i.usage);
      if (
        (!traffic.valid ||
          traffic.over ||
          !schedule(rule, new Date()).allowed ||
          (rule.hold === "traffic" && action !== "resume")) &&
        !override
      )
        throw Object.assign(
          new Error("流量保护或定时规则禁止开机；请先修改流量保护或定时设置"),
          { status: 409 },
        );
      if (override) this.store.saveRule(t, { paused: true });
      if (i.expires && Date.parse(i.expires) <= Date.now())
        throw new Error("实例已到期，无法保活或开机");
    }
    return this.enqueue(t, normalized, "manual", {
      resume: action === "resume",
      override,
      stoppedMode,
    });
  }
  async tick() {
    const jobs = this.store
      .list("job")
      .filter(
        (j) =>
          ["queued", "submitted"].includes(j.status) &&
          !this.running.has(j.id) &&
          (j.nextPollAt || 0) <= Date.now(),
      )
      .sort((a, b) => (a.nextPollAt || 0) - (b.nextPollAt || 0));
    for (const job of jobs.slice(0, 3)) {
      this.running.add(job.id);
      this.run(job)
        .catch((e) => {
          const latest = this.store.get("job", job.id) || job;
          if (Date.now() - (latest.submittedAt || latest.at) < 600000)
            this.store.put("job", job.id, {
              ...latest,
              detail: "状态查询失败，稍后继续核对：" + errorText(e),
              nextPollAt: Date.now() + 15000,
            });
          else this.finish(latest, "attention", errorText(e));
        })
        .finally(() => {
          this.running.delete(job.id);
          const latest = this.store.get("job", job.id);
          if (latest?.status === "submitted")
            this.store.put("job", job.id, {
              ...latest,
              nextPollAt: Math.max(latest.nextPollAt || 0, Date.now() + 5000),
            });
        });
    }
  }
  async run(j) {
    const t = { accountId: j.accountId, region: j.region, id: j.instanceId };
    if (!this.store.accounts().some((a) => a.id === t.accountId))
      return this.finish(j, "failed", "账号已移除");
    if (!["start", "stop"].includes(j.action))
      return this.finish(j, "failed", "此功能已移除，未执行云端操作");
    const payload = this.store.decrypt(j.secretPayload);
    if (j.status === "queued") {
      if (["start", "stop"].includes(j.action) && j.source !== "manual") {
        const i = await this.service.refreshTarget(t, {
            usage: this.store.rule(t).thresholdEnabled,
          }),
          rule = this.store.rule(t);
        const d = decide(i, rule, this.store.settings());
        if (payload.revision !== rule.revision || d.action !== j.action)
          return this.finish(j, "failed", "规则已改变，取消未提交动作");
      }
      j = {
        ...j,
        status: "submitted",
        updatedAt: Date.now(),
        submittedAt: Date.now(),
      };
      if (
        !this.store.db
          .prepare(
            "UPDATE entities SET body=? WHERE kind='job' AND id=? AND json_extract(body,'$.status')='queued'",
          )
          .run(JSON.stringify(j), j.id).changes
      )
        return;
      try {
        let b;
        if (["start", "stop"].includes(j.action)) {
          const i = await this.service.refreshTarget(t, {
            usage: j.action === "start" && this.store.rule(t).thresholdEnabled,
          });
          if (
            j.action === "start" &&
            j.source === "manual" &&
            !payload.override
          ) {
            const rule = this.store.rule(t),
              traffic = usageOver(rule, i.usage);
            if (
              !traffic.valid ||
              traffic.over ||
              !schedule(rule, new Date()).allowed ||
              (rule.hold === "traffic" && !payload.resume)
            )
              return this.finish(
                j,
                "failed",
                "当前保护规则禁止启动，请重新确认",
              );
          }
          const same =
            (j.action === "start" && i.status === "Running") ||
            (j.action === "stop" && i.status === "Stopped");
          if (j.source !== "manual") {
            const latest = this.store.rule(t),
              decision = decide(i, latest, this.store.settings());
            if (
              payload.revision !== latest.revision ||
              decision.action !== j.action
            )
              return this.finish(j, "failed", "提交前规则已改变，取消动作");
          }
          b = same
            ? {}
            : await this.gateway.control(t, j.action, j.clientToken, {
                stoppedMode: payload.stoppedMode || "KeepCharging",
              });
        } else throw new Error("此功能已移除");
        j.requestId = b?.requestId;
        this.store.put("job", j.id, j);
        this.store.updateAudit(j.auditId, {
          status: "submitted",
          detail: "请求已提交，正在核对实例状态",
          context: {
            phase: "submitted",
            requestId: j.requestId,
            submittedAt: j.submittedAt,
          },
        });
      } catch (e) {
        let backoff = false;
        if (
          j.source !== "manual" &&
          /AccessDenied|Forbidden|Unauthorized|NoPermission|InvalidAccessKey|SignatureDoesNotMatch|LockedForSecurity/i.test(
            e.code || "",
          )
        ) {
          backoff = true;
          this.store.put("health", "control:" + resourceKey(t), {
            code: e.code,
            at: Date.now(),
            retryAt: Date.now() + 300000,
          });
          this.store.progress(t, {
            reason: "云端权限或安全限制，5 分钟后按当前规则重试",
          });
        }
        const known =
          !!e.code &&
          !/timeout|network|reset|unavailable|internal|throttl/i.test(e.code);
        return this.finish(
          j,
          known ? "failed" : "attention",
          errorText(e) +
            (backoff ? "；5 分钟后按当前规则重试" : "；请核对云端状态"),
        );
      }
    }
    if (Date.now() - (j.submittedAt || j.at) > 600000)
      return this.finish(j, "attention", "超过跟踪时间，请核对云端状态");
    if (["start", "stop"].includes(j.action)) {
      const i = await this.service.refreshTarget(t),
        expected = j.action === "stop" ? "Stopped" : "Running";
      if (i.status !== expected) return;
      const rule = this.store.rule(t);
      this.store.remove("health", "control:" + resourceKey(t));
      this.store.progress(t, {
        lastAction: new Date().toISOString(),
        ...(j.action === "start" ? { hold: undefined } : {}),
        ...(payload.resume ? { paused: false } : {}),
        ...(payload.scheduleKey ? { lastSchedule: payload.scheduleKey } : {}),
        reason: expected === "Stopped" ? "实例已停止" : "实例运行中",
      });
      return this.finish(
        j,
        "success",
        expected === "Stopped" ? "已确认实例停止" : "已确认实例运行",
      );
    }
  }
}
