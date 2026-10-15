import { randomUUID } from "node:crypto";
import { errorText } from "./aliyun.mjs";
import { zoned } from "./policy.mjs";
export const billingCycle = () => zoned(new Date(), "Asia/Shanghai").month;
export const billKey = (accountId, cycle) => JSON.stringify([accountId, cycle]);
const billingError = (error) => {
  const text = errorText(error);
  return /AuthSiteFail|caller site matches|site.*(?:not match|mismatch)/i.test(
    text,
  )
    ? "账号所属站点与账单接口不匹配，请在编辑实例中核对国内站或国际站"
    : text;
};
export const amount = (value) =>
  value == null || value === "" || !Number.isFinite(Number(value))
    ? null
    : Number(value);
export function instanceAmount(rows, id) {
  const own = rows.filter((r) => r.instanceID === id);
  if (!own.length) return 0;
  if (own.some((r) => amount(r.pretaxAmount) === null)) return null;
  return own.reduce((sum, r) => sum + amount(r.pretaxAmount), 0);
}
export class BillingService {
  constructor(store, gateway, service, notify) {
    Object.assign(this, { store, gateway, service, notify });
    this.running = new Map();
  }
  view(cycle = billingCycle(), accountId = "all") {
    return {
      cycle,
      items: this.store
        .accounts()
        .filter((a) => accountId === "all" || a.id === accountId)
        .map((a) => {
          const b = this.store.get("billing", billKey(a.id, cycle));
          const instances = this.service.instances({ accountId: a.id }).items;
          return {
            ...b,
            accountId: a.id,
            accountName: a.name,
            site: a.site,
            cycle,
            currency:
              b?.currency || (a.site === "international" ? "USD" : "CNY"),
            error: b?.error,
            instances: instances.map((i) => ({
              id: i.id,
              name: i.name,
              region: i.region,
              amount: b?.items ? instanceAmount(b.items, i.id) : null,
            })),
            stale:
              !!b?.error ||
              !b?.at ||
              Date.now() - b.at > this.store.settings().billingInterval * 1000,
            refreshing: this.running.has(billKey(a.id, cycle)),
          };
        }),
    };
  }
  async refresh({
    cycle = billingCycle(),
    accountId = "all",
    force = false,
  } = {}) {
    const accounts = this.store
      .accounts()
      .filter((a) => accountId === "all" || a.id === accountId);
    for (const a of accounts) {
      const key = billKey(a.id, cycle),
        old = this.store.get("billing", key);
      if (this.running.has(key)) {
        await this.running.get(key);
        continue;
      }
      const ttl = old?.error
        ? Math.min(900, this.store.settings().billingInterval)
        : this.store.settings().billingInterval;
      if (!force && old && Date.now() - old.checkedAt < ttl * 1000) continue;
      const promise = this.collect(a, cycle, old).finally(() =>
        this.running.delete(key),
      );
      this.running.set(key, promise);
      await promise;
    }
    return this.view(cycle, accountId);
  }
  async collect(a, cycle, old) {
    const initial = this.store.account(a.id),
      startedAt = Date.now();
    const [balanceResult, billResult] = await Promise.allSettled([
      this.gateway.balance(a.id),
      this.gateway.billRows(a.id, cycle),
    ]);
    // Balance permission failure must not suppress otherwise valid instance bills.
    const b = { ...old, accountId: a.id, cycle, checkedAt: Date.now() };
    const errors = [];
    if (balanceResult.status === "fulfilled") {
      b.balance = balanceResult.value;
      b.balanceAt = Date.now();
    } else errors.push("余额：" + billingError(balanceResult.reason));
    if (billResult.status === "fulfilled") {
      b.items = billResult.value;
      b.at = Date.now();
      b.currency =
        b.items[0]?.currency ||
        b.balance?.currency ||
        (a.site === "international" ? "USD" : "CNY");
    } else errors.push("账单：" + billingError(billResult.reason));
    b.error = errors.join("；") || undefined;
    b.billError =
      billResult.status === "rejected"
        ? billingError(billResult.reason)
        : undefined;
    b.balanceError =
      balanceResult.status === "rejected"
        ? billingError(balanceResult.reason)
        : undefined;
    if (this.store.accounts().some((x) => x.id === a.id)) {
      const current = this.store.account(a.id);
      if (
        current.site === initial.site &&
        current.credentials.accessKeyId === initial.credentials.accessKeyId &&
        current.credentials.accessKeySecret ===
          initial.credentials.accessKeySecret
      ) {
        this.store.put("billing", billKey(a.id, cycle), b);
        const signature = (value) =>
          (value || "").replace(/[a-f0-9-]{20,}/gi, "...");
        const affected = this.service.instances({ accountId: a.id }).items;
        const instance = affected.length
          ? { name: affected[0].name, region: affected[0].region }
          : undefined;
        const suffix =
          affected.length > 1
            ? `；另有 ${affected.length - 1} 台实例共用此凭据`
            : "";
        if (b.error && signature(b.error) !== signature(old?.error))
          this.notify?.event(
            "billing-error:" + randomUUID(),
            "账单查询异常",
            b.error +
              (old ? "；已保留上次成功数据" : "；暂无可用缓存") +
              suffix,
            { level: "error", instance },
          );
        else if (!b.error && old?.error)
          this.notify?.event(
            "billing-recovery:" + randomUUID(),
            "账单查询恢复",
            "账单与余额已成功刷新" + suffix,
            { instance },
          );
        this.store.audit({
          account: a.id,
          action: "billing-refresh",
          category: "billing",
          status: b.error ? "failed" : "success",
          detail: b.error || "账单与余额查询完成",
          context: {
            accountName: a.name,
            site: a.site,
            cycle,
            durationMs: Date.now() - startedAt,
            balanceStatus:
              balanceResult.status === "fulfilled" ? "success" : "failed",
            billStatus:
              billResult.status === "fulfilled" ? "success" : "failed",
            balanceAt: b.balanceAt,
            billAt: b.at,
            checkedAt: b.checkedAt,
            currency: b.currency,
            availableAmount: b.balance?.availableAmount,
            rows: b.items?.length,
            retainedCache: !!b.error && !!old,
          },
        });
      }
    }
  }
}
