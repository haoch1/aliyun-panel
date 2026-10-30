import {
  errorText,
  monitorSource,
  trafficMetric,
  networkErrorCode,
} from "./aliyun.mjs";
import { resourceKey } from "./store.mjs";
import { billKey, billingCycle, instanceAmount } from "./billing.mjs";
import { nextSchedule } from "./policy.mjs";
import { randomUUID } from "node:crypto";
import { sortByName } from "../shared/resource-order.ts";
import { TrafficHistory, MINUTE, HOUR } from "./traffic-history.mjs";
export async function mapLimit(items, n, run) {
  const output = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (index < items.length) {
        const i = index++;
        output[i] = await run(items[i], i);
      }
    }),
  );
  return output;
}
export class ResourceService {
  constructor(store, gateway) {
    this.store = store;
    this.gateway = gateway;
    this.refreshing = null;
    this.trafficSync = new Map();
    this.closed = false;
    this.capturing = null;
    this.history = new TrafficHistory(store, gateway, (t) =>
      this.closed ? undefined : this.instance(t),
    );
    store.onClose.add(() => {
      this.closed = true;
    });
  }
  observeTraffic(items) {
    for (const i of items)
      if (i.publicNetwork === "eip" || this.history.has(i))
        this.history.observe(i, i.statusAt || Date.now());
  }
  captureTraffic(filter = {}) {
    if (this.closed) return Promise.resolve();
    if (this.capturing) return this.capturing;
    const items = this.instances(filter).items.filter(
      (i) => i.publicNetwork === "eip" || this.history.has(i),
    );
    this.capturing = mapLimit(items, 2, async (i) => {
      if (this.closed) return;
      const now = Date.now(),
        start = Date.parse(
          new Date(now + 8 * HOUR).toISOString().slice(0, 7) +
            "-01T00:00:00+08:00",
        );
      await this.history.sync(i, start, Math.floor(now / MINUTE) * MINUTE);
    }).finally(() => {
      this.capturing = null;
    });
    return this.capturing;
  }
  scopes() {
    return this.store
      .list("scope")
      .filter((s) => this.store.accounts().some((a) => a.id === s.accountId))
      .map((s) => {
        const a = this.store.account(s.accountId);
        return {
          ...s,
          items: s.items.filter(
            (i) =>
              !a.monitors ||
              a.monitors.some((m) => m.id === i.id && m.region === i.region),
          ),
        };
      });
  }
  writePartial(scope, updates, usageIds = [], metadata = {}) {
    if (!this.store.accounts().some((a) => a.id === scope.accountId)) return;
    const id = JSON.stringify([scope.accountId, scope.region]),
      latest = this.store.get("scope", id) || scope;
    // A concurrent discovery may have replaced names, network bindings and
    // statuses while this request was in flight. Keep that newer snapshot.
    const sameDiscovery = latest.discoveryVersion === scope.discoveryVersion;
    const completeMetadata =
      sameDiscovery &&
      latest.items.length > 0 &&
      latest.items.every((i) => metadata[i.id]);
    const usage = { ...latest.usage };
    for (const key of usageIds) {
      const incoming = scope.usage?.[key],
        current = usage[key];
      if (
        incoming &&
        Math.max(incoming.at || 0, incoming.errorAt || 0) >=
          Math.max(current?.at || 0, current?.errorAt || 0)
      )
        usage[key] = incoming;
    }
    this.store.put("scope", id, {
      ...latest,
      ...(sameDiscovery
        ? {
            statusAt: scope.statusAt,
            statusError: scope.error,
            discoveryError: completeMetadata
              ? undefined
              : latest.discoveryError,
            error:
              scope.error ||
              (completeMetadata ? undefined : latest.discoveryError),
            ...(completeMetadata ? { at: scope.statusAt } : {}),
          }
        : {}),
      items: latest.items.map((i) =>
        sameDiscovery && updates[i.id]
          ? { ...i, ...metadata[i.id], ...updates[i.id] }
          : i,
      ),
      usage,
    });
    if (sameDiscovery)
      this.observeTraffic(
        this.store.get("scope", id).items.filter((i) => metadata[i.id]),
      );
  }
  instances(filter = {}) {
    const settings = this.store.settings(),
      active = this.store
        .list("job")
        .filter((j) => ["queued", "submitted", "attention"].includes(j.status));
    const scopes = this.scopes().filter(
      (s) =>
        (!filter.accountId ||
          filter.accountId === "all" ||
          s.accountId === filter.accountId) &&
        (!filter.region ||
          filter.region === "all" ||
          s.region === filter.region),
    );
    const items = scopes.flatMap((s) =>
      s.items.map((i) => {
        const bill = this.store.get(
          "billing",
          billKey(i.accountId, billingCycle()),
        );
        const rule = this.store.rule(i),
          job = active.find(
            (j) =>
              j.accountId === i.accountId &&
              j.region === i.region &&
              j.instanceId === i.id,
          );
        return {
          ...i,
          name:
            this.store
              .account(i.accountId)
              .monitors?.find((m) => m.region === i.region && m.id === i.id)
              ?.name || i.name,
          usage: s.usage?.[i.id],
          rule,
          effectiveKeepAlive: rule.keepAlive ?? settings.keepAliveDefault,
          job: job
            ? {
                id: job.id,
                action: job.action,
                status: job.status,
                source: job.source,
                at: job.at,
                detail: job.detail,
              }
            : undefined,
          error: s.error,
          billing: settings.billingEnabled
            ? {
                amount: bill?.items ? instanceAmount(bill.items, i.id) : null,
                currency:
                  bill?.currency ||
                  (this.store.account(i.accountId).site === "international"
                    ? "USD"
                    : "CNY"),
                at: bill?.at,
                error: bill?.billError,
                stale:
                  !!bill?.billError ||
                  !bill?.at ||
                  Date.now() - bill.at > settings.billingInterval * 1000,
              }
            : undefined,
          schedule: rule.scheduleEnabled
            ? nextSchedule(rule, new Date())
            : undefined,
          trafficAt: this.store.get("health", "traffic:" + resourceKey(i))?.at,
        };
      }),
    );
    return {
      items: sortByName(items),
      at: Math.min(...scopes.map((s) => s.at || 0), Date.now()),
      errors: scopes
        .filter((s) => s.error)
        .map((s) => `${s.region}: ${s.error}`),
      refreshing: !!this.refreshing,
    };
  }
  instance(t) {
    return this.instances({
      accountId: t.accountId,
      region: t.region,
    }).items.find((i) => i.id === t.id);
  }
  async collectUsage(scope, ids, options = {}) {
    try {
      const rows = await this.gateway.usage(
          scope.accountId,
          scope.region,
          ids,
          options,
        ),
        at = Date.now();
      const fresh = Object.fromEntries(
        ids.map((id) => {
          const row = rows.find((r) => r.instanceId === id),
            i = scope.items.find((x) => x.id === id);
          const finite =
            row &&
            Number.isFinite(row.trafficUsed) &&
            Number.isFinite(row.trafficPackageTotal) &&
            row.trafficPackageTotal > 0;
          const none = i?.flow === 0;
          return [
            id,
            {
              used: row?.trafficUsed ?? null,
              total: row?.trafficPackageTotal ?? null,
              remaining: row?.trafficPackageRemaining ?? null,
              overflow: row?.trafficOverflow ?? null,
              quota: finite ? "finite" : none ? "none" : "unknown",
              at: row?.at ?? at,
              scope: row?.scope,
              pool: row?.pool,
              ...(!row && !none ? { error: "云端未返回 CDT 用量" } : {}),
            },
          ];
        }),
      );
      scope.usage = { ...scope.usage, ...fresh };
    } catch (e) {
      for (const id of ids)
        scope.usage = {
          ...scope.usage,
          [id]: {
            ...scope.usage?.[id],
            at: scope.usage?.[id]?.at || 0,
            error: errorText(e),
            errorAt: Date.now(),
          },
        };
    }
    return scope;
  }
  async refresh(filter = {}) {
    if (this.refreshing) {
      await this.refreshing;
    }
    this.refreshing = this.discover(filter).finally(() => {
      this.refreshing = null;
      this.store.emit("resources");
    });
    await this.refreshing;
    return this.instances(filter);
  }
  async discover(filter) {
    const scopes = [];
    for (const a of this.store
      .accounts()
      .filter(
        (a) =>
          !filter.accountId ||
          filter.accountId === "all" ||
          a.id === filter.accountId,
      )) {
      try {
        const regions = a.monitors
          ? [...new Set(a.monitors.map((t) => t.region))]
              .map((regionId) => ({ regionId }))
              .filter(
                (r) =>
                  !filter.region ||
                  filter.region === "all" ||
                  r.regionId === filter.region,
              )
          : filter.region && filter.region !== "all"
            ? [{ regionId: filter.region }]
            : await this.gateway.regions(a.id);
        for (const r of regions)
          scopes.push({ accountId: a.id, region: r.regionId });
      } catch (e) {
        this.store.put("scope", JSON.stringify([a.id, a.region]), {
          ...this.store.get("scope", JSON.stringify([a.id, a.region])),
          accountId: a.id,
          region: a.region,
          items:
            this.store.get("scope", JSON.stringify([a.id, a.region]))?.items ||
            [],
          error: errorText(e),
          at: 0,
        });
      }
    }
    await mapLimit(scopes, 4, async (t) => {
      const key = JSON.stringify([t.accountId, t.region]),
        old = this.store.get("scope", key);
      try {
        const a = this.store.account(t.accountId);
        const items = (
            await this.gateway.instances(
              t.accountId,
              t.region,
              a.monitors?.filter((m) => m.region === t.region).map((m) => m.id),
            )
          ).filter(
            (i) =>
              !a.monitors ||
              a.monitors.some((m) => m.id === i.id && m.region === i.region),
          ),
          scope = {
            ...t,
            items: items.map((i) => ({ ...i, statusAt: Date.now() })),
            at: Date.now(),
            statusAt: Date.now(),
            discoveryVersion: randomUUID(),
            usage: old?.usage || {},
          };
        if (items.length)
          await this.collectUsage(
            scope,
            items.map((i) => i.id),
          );
        if (this.store.accounts().some((a) => a.id === t.accountId)) {
          const current = this.store.account(t.accountId);
          scope.items = scope.items.filter(
            (i) =>
              !current.monitors ||
              current.monitors.some(
                (m) => m.region === i.region && m.id === i.id,
              ),
          );
          this.store.put("scope", key, scope);
          this.observeTraffic(scope.items);
        }
      } catch (e) {
        if (this.store.accounts().some((a) => a.id === t.accountId))
          this.store.put("scope", key, {
            ...t,
            ...old,
            items: old?.items || [],
            error: errorText(e),
            discoveryError: errorText(e),
            statusAt: 0,
          });
      }
    });
  }
  async refreshTarget(t, { usage = false } = {}) {
    const account = this.store.account(t.accountId);
    if (
      account.monitors &&
      !account.monitors.some((m) => m.region === t.region && m.id === t.id)
    )
      throw new Error("此实例未接入监控");
    const key = JSON.stringify([t.accountId, t.region]);
    let scope = this.store.get("scope", key);
    if (!scope) {
      await this.refresh({ accountId: t.accountId, region: t.region });
      scope = this.store.get("scope", key);
    }
    if (!scope?.items.find((i) => i.id === t.id))
      throw new Error("实例尚未发现或不存在，请刷新列表");
    const status = await this.gateway.status(t);
    scope = {
      ...scope,
      items: scope.items.map((i) => (i.id === t.id ? { ...i, status } : i)),
      statusAt: Date.now(),
    };
    if (usage) await this.collectUsage(scope, [t.id]);
    if (!this.store.accounts().some((a) => a.id === t.accountId))
      throw new Error("账号已移除");
    this.writePartial(
      scope,
      { [t.id]: { status, statusAt: scope.statusAt, statusError: undefined } },
      usage ? [t.id] : [],
    );
    return this.instance(t);
  }
  async statusCycle(filter = {}) {
    const cycleCache = new Map();
    await mapLimit(
      this.scopes().filter(
        (s) =>
          (!filter.accountId ||
            filter.accountId === "all" ||
            s.accountId === filter.accountId) &&
          (!filter.region ||
            filter.region === "all" ||
            s.region === filter.region),
      ),
      3,
      async (old) => {
        // Failed initial discovery must remain recoverable on the next due
        // poll even when other regions already contain healthy instances.
        if (!old.items.length) {
          await this.refresh({ accountId: old.accountId, region: old.region });
          return;
        }
        const scope = { ...old };
        const updates = {};
        const metadata = {};
        try {
          const statuses = await this.gateway.statuses(
            scope.accountId,
            scope.region,
            scope.items.map((i) => i.id),
          );
          scope.statusAt = Date.now();
          for (const i of scope.items) {
            const result = statuses.find((x) => x.instanceId === i.id);
            if (result?.status && !result.error && result.instance)
              metadata[i.id] = result.instance;
            updates[i.id] =
              !result?.status || result.error
                ? {
                    statusAt: 0,
                    statusError: result?.error || "云端未返回 ECS 实例状态",
                  }
                : {
                    status: result.status,
                    statusAt: scope.statusAt,
                    statusError: undefined,
                  };
          }
          delete scope.error;
        } catch (e) {
          scope.error = errorText(e);
          scope.statusAt = 0;
          for (const i of scope.items)
            updates[i.id] = { statusAt: 0, statusError: scope.error };
        }
        const ids = scope.items.map((i) => i.id);
        if (ids.length) await this.collectUsage(scope, ids, { cycleCache });
        this.writePartial(scope, updates, ids, metadata);
      },
    );
  }
  async traffic(t, days) {
    if (!this.instance(t)) throw new Error("此实例未添加监控或尚未同步");
    // Older databases lack the public-network metadata. Discover it before
    // selecting an API, rather than treating an unknown EIP as fixed ECS IP.
    if (!this.instance(t).publicNetwork) {
      if (this.refreshing) await this.refreshing;
      if (!this.instance(t)?.publicNetwork)
        await this.refresh({ accountId: t.accountId, region: t.region });
      if (!this.instance(t)?.publicNetwork)
        throw new Error("实例公网类型尚未同步，请稍后重试");
    }
    const scope = this.store.get(
      "scope",
      JSON.stringify([t.accountId, t.region]),
    );
    await this.collectUsage(scope, [t.id]);
    this.writePartial(scope, {}, [t.id]);
    const instance = this.instance(t);
    if (instance?.publicNetwork === "eip" && !instance.eipAllocationId)
      throw new Error("EIP 标识尚未同步，请刷新实例后重试");
    if (instance.publicNetwork === "eip" || this.history.has(t)) {
      const now = Date.now(),
        end = Math.floor(now / MINUTE) * MINUTE;
      const local = new Date(now + 8 * HOUR).toISOString();
      const start =
        days === "month"
          ? Date.parse(local.slice(0, 7) + "-01T00:00:00+08:00")
          : Date.parse(local.slice(0, 10) + "T00:00:00+08:00") -
            (days - 1) * 86400000;
      const states = await this.history.sync(t, start, end);
      const items = this.closed ? [] : this.history.days(t, start, end);
      return {
        start,
        end,
        timezone: "Asia/Shanghai",
        estimated: true,
        checkedAt: Math.max(0, ...states.map((s) => s.checkedAt || 0)),
        usage: instance.usage,
        items,
        errors: [
          ...new Set(
            states
              .filter((s) => s.error && !s.historical)
              .map(
                (s) =>
                  errorText({ message: s.error, code: s.errorCode }) +
                  (items.length ? "；已保留上次流量数据" : ""),
              ),
          ),
        ],
        warnings: [
          ...new Set(
            states
              .filter((s) => s.warning || (s.error && s.historical))
              .map(
                (s) =>
                  s.warning ||
                  "旧 EIP 历史补采暂时失败，已保留累计；当前 EIP 单独采集：" +
                    errorText({ message: s.error, code: s.errorCode }),
              ),
          ),
        ],
      };
    }
    const now = Date.now(),
      end = Math.floor(now / 3600000) * 3600000,
      local = new Date(now + 8 * 3600000).toISOString(),
      start =
        days === "month"
          ? Date.parse(local.slice(0, 7) + "-01T00:00:00+08:00")
          : Date.parse(local.slice(0, 10) + "T00:00:00+08:00") -
            (days - 1) * 86400000;
    if (end <= start)
      return {
        start,
        end,
        timezone: "Asia/Shanghai",
        estimated: true,
        checkedAt: Date.now(),
        usage: this.instance(t)?.usage,
        items: [],
        errors: [],
      };
    const synced = await this.syncTraffic(t, start, end);
    const source = monitorSource(this.instance(t));
    const metrics = ["INTERNET_IN", "INTERNET_OUT"];
    const rows = new Map();
    for (const metric of metrics)
      for (const p of this.store.metrics(
        t,
        trafficMetric(source, metric),
        start,
        end,
      )) {
        const date = new Date(p.at - 1).toLocaleDateString("en-CA", {
            timeZone: "Asia/Shanghai",
          }),
          r = rows.get(date) || {
            date,
            inBytes: null,
            outBytes: null,
            flowBytes: null,
            inPoints: 0,
            outPoints: 0,
            flowPoints: 0,
          };
        const field = metric === "INTERNET_IN" ? "inBytes" : "outBytes";
        r[field] = (r[field] ?? 0) + p.value;
        r[field === "inBytes" ? "inPoints" : "outPoints"]++;
        rows.set(date, r);
      }
    return {
      start,
      end,
      timezone: "Asia/Shanghai",
      estimated: true,
      checkedAt: synced.checkedAt,
      usage: this.instance(t)?.usage,
      items: [...rows.values()].sort((a, b) => b.date.localeCompare(a.date)),
      errors: synced.error
        ? [
            errorText({ message: synced.error, code: synced.errorCode }) +
              (rows.size ? "；已保留上次流量数据" : ""),
          ]
        : [],
    };
  }
  async syncTraffic(t, start, end) {
    const key = resourceKey(t);
    if (this.trafficSync.has(key)) {
      await this.trafficSync.get(key);
      return this.syncTraffic(t, start, end);
    }
    const instance = this.instance(t);
    if (!instance) throw new Error("实例已移除");
    const source = monitorSource(instance);
    const saved = this.store.get("traffic-sync", key);
    // Do not reuse old ECS zeroes, units or a previous EIP's history after rebinding.
    const previous = saved?.source === source ? saved : undefined;
    const now = Date.now();
    if (previous?.retryAt > now) return previous;
    if (
      !previous?.error &&
      previous?.start <= start &&
      previous.end >= end &&
      now - previous.checkedAt < 300000
    )
      return previous;
    // Completed history is persistent; revisit the latest two hours for delayed data.
    const from =
      previous?.start <= start && previous.end >= start
        ? Math.max(start, Math.min(previous.end, end) - 2 * 3600000)
        : start;
    const run = async () => {
      try {
        const metrics = ["INTERNET_IN", "INTERNET_OUT"];
        const series = await Promise.all(
          metrics.map((metric) =>
            this.gateway.monitor(
              {
                ...t,
                publicNetwork: instance.publicNetwork,
                eipAllocationId: instance.eipAllocationId,
              },
              metric,
              from,
              end,
              3600,
            ),
          ),
        );
        if (!this.instance(t))
          throw new Error("实例已移除，已丢弃监控查询结果");
        if (monitorSource(this.instance(t)) !== source)
          throw new Error("实例公网配置已变化，已丢弃旧监控结果，请重新查询");
        for (let n = 0; n < metrics.length; n++) {
          for (const p of series[n]) {
            const raw =
              p.timestamp ?? p.Timestamp ?? p.time ?? p.TimeStamp ?? p[0];
            const numeric =
              typeof raw === "number" ||
              (typeof raw === "string" && /^\d{10,13}$/.test(raw));
            const at = numeric
              ? +raw < 1e12
                ? +raw * 1000
                : +raw
              : Date.parse(raw);
            const value = p.value ?? p.Value ?? p.average ?? p.Average ?? p[1];
            if (
              value != null &&
              value !== "" &&
              Number.isFinite(at) &&
              Number.isFinite(+value) &&
              +value >= 0 &&
              at > from &&
              at <= end
            )
              this.store.saveMetric(
                t,
                trafficMetric(source, metrics[n]),
                at,
                +value,
              );
          }
        }
        const state = {
          ...t,
          source,
          start:
            previous && previous.end >= from
              ? Math.min(previous.start, from)
              : from,
          end,
          checkedAt: Date.now(),
        };
        this.store.put("traffic-sync", key, state);
        return state;
      } catch (e) {
        const errorCode = networkErrorCode(e);
        const error = errorText(e)
          .split(/(?:POST|GET) https?:\/\//)[0]
          .trim();
        const state = {
          ...previous,
          ...t,
          source,
          error,
          errorCode,
          // Transient network failures recover sooner; permission failures stay cooled.
          retryAt: Date.now() + (errorCode ? 60000 : 300000),
        };
        if (this.instance(t) && monitorSource(this.instance(t)) === source) {
          this.store.put("traffic-sync", key, state);
          this.store.audit({
            account: t.accountId,
            action: "traffic-query",
            category: "query",
            target: this.instance(t).name,
            status: "failed",
            detail: error,
            context: {
              api: source.startsWith("eip:")
                ? "DescribeEipMonitorData"
                : "DescribeInstanceMonitorData",
              region: t.region,
              instanceId: t.id,
              start: from,
              end,
              retryAt: state.retryAt,
              errorCode: errorCode || e.code,
            },
          });
        }
        return state;
      }
    };
    const pending = run().finally(() => this.trafficSync.delete(key));
    this.trafficSync.set(key, pending);
    return pending;
  }
}
