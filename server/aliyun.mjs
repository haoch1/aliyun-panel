import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { zoned } from "../shared/policy.mjs";
const require = createRequire(import.meta.url);
const products = {
  ecs: "@alicloud/ecs20140526",
  cdt: "@alicloud/cdt20210813",
  sts: "@alicloud/sts20150401",
  bss: "@alicloud/bssopenapi20171214",
  vpc: "@alicloud/vpc20160428",
};
const sdk = (product) => {
  if (!Object.hasOwn(products, product)) throw new Error("不支持的云产品");
  return require(products[product]);
};
const cacheLimit = 128;
export const monitorSource = (t) =>
  t.eipAllocationId
    ? "eip:" + t.eipAllocationId
    : t.publicNetwork === "eip"
      ? "eip:unknown"
      : "ecs:" + t.id;
export const trafficMetric = (source, metric) =>
  JSON.stringify(["public-traffic-bytes-v2", source, metric]);
export const trafficClass = (region) =>
  region.startsWith("cn-") && region !== "cn-hongkong"
    ? "china"
    : "international";
export const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const networkCodes = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
];
export function networkErrorCode(error) {
  // SDK transport errors and persisted errors may only expose the code in text.
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (current.name === "TimeoutError") return "ETIMEDOUT";
    if (networkCodes.includes(current.code)) return current.code;
    const match = String(current.message || current).match(
      /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)\b/,
    );
    if (match) return match[1];
    current = current.cause;
  }
}
export function errorText(error, secrets = [], provider = "阿里云") {
  const code = networkErrorCode(error);
  const api = provider === "Telegram" ? "Telegram 接口" : "阿里云接口";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return api + "域名暂时无法解析，请稍后重试";
  if (code === "ETIMEDOUT") return api + "连接超时，请稍后重试";
  if (code) return api + "连接暂时中断，请稍后重试";
  let text = String(error?.message || error || "请求失败").slice(0, 3000);
  for (const s of secrets.filter(Boolean))
    text = text.split(s).join("[已隐藏]");
  return text
    .replace(/LTAI[\w]+/g, "[AccessKey]")
    .replace(
      /(accessKeySecret|SecurityToken|token|Signature)([=:"\s]+)[^\s&,"}]+/gi,
      "$1$2[已隐藏]",
    );
}
export class AliyunGateway {
  constructor(store, { rpc } = {}) {
    this.store = store;
    this.rpc = rpc;
    this.clients = new Map();
    this.cache = new Map();
    this.pending = new Map();
    this.epoch = 0;
    const timer = setInterval(() => this.pruneCache(), 30000).unref();
    store.onClose?.add(() => clearInterval(timer));
  }
  invalidate() {
    this.epoch++;
    this.clients.clear();
    this.cache.clear();
    this.pending.clear();
  }
  client(product, a, region) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(a.credentials))
      .digest("hex");
    const key = JSON.stringify([product, a.id, fingerprint, region, a.site]);
    if (!this.clients.has(key)) {
      const Core = require("@alicloud/openapi-core"),
        Dara = require("@darabonba/typescript");
      const endpoint =
        product === "sts"
          ? "sts.aliyuncs.com"
          : product === "bss"
            ? a.site === "international"
              ? "business.ap-southeast-1.aliyuncs.com"
              : "business.aliyuncs.com"
            : product === "cdt"
              ? "cdt.aliyuncs.com"
              : product === "vpc"
                ? undefined // Use the VPC SDK's official regional endpoint map.
                : "ecs." + region + ".aliyuncs.com";
      const c = new Core.$OpenApiUtil.Config({
        accessKeyId: a.credentials.accessKeyId,
        accessKeySecret: a.credentials.accessKeySecret,
        regionId: region,
        endpoint,
        protocol: "HTTPS",
        // The current OpenAPI SDK ignores RuntimeOptions.autoretry/maxAttempts.
        // Disable its retries; call() bounds read retries and never retries writes.
        retryOptions: new Dara.RetryOptions({ retryable: false }),
      });
      const client = new (sdk(product).default)(c);
      if (this.clients.size >= cacheLimit)
        this.clients.delete(this.clients.keys().next().value);
      this.clients.set(key, client);
    }
    const client = this.clients.get(key);
    this.clients.delete(key);
    this.clients.set(key, client);
    return client;
  }
  async call(
    accountOrId,
    region,
    action,
    parameters = {},
    { product = "ecs", write = false } = {},
  ) {
    const a =
      typeof accountOrId === "string"
        ? this.store.account(accountOrId)
        : accountOrId;
    if (this.rpc)
      return this.rpc(a, region, action, parameters, { product, write });
    const model = sdk(product),
      c = this.client(product, a, region);
    const Dara = require("@darabonba/typescript");
    const runtime = new Dara.RuntimeOptions({
      connectTimeout: 5000,
      readTimeout: 15000,
    });
    const method = action[0].toLowerCase() + action.slice(1) + "WithOptions";
    const attempts = write ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        let response;
        if (typeof c[method] === "function") {
          const Model = model[action + "Request"];
          if (Model) response = await c[method](new Model(parameters), runtime);
          else {
            if (Object.keys(parameters).length)
              throw new Error("无参数接口收到多余参数");
            response = await c[method](runtime);
          }
        } else throw new Error("不支持的接口 " + action);
        const body = response.body;
        if (
          body?.success === false ||
          (body?.code && !["Success", "200", "OK"].includes(body.code))
        )
          throw new Error(`${body.code}: ${body.message || "接口拒绝请求"}`);
        return body;
      } catch (e) {
        const code = networkErrorCode(e);
        if (code && !write && attempt + 1 < attempts) {
          await delay(500 * 2 ** attempt);
          continue;
        }
        const err = new Error(errorText(e, Object.values(a.credentials)));
        err.code = code || e.code;
        throw err;
      }
    }
  }
  pruneCache() {
    const now = Date.now();
    for (const [key, entry] of this.cache)
      if (entry.expires <= now) this.cache.delete(key);
    while (this.cache.size > cacheLimit)
      this.cache.delete(this.cache.keys().next().value);
  }
  async cached(key, ttl, run) {
    this.pruneCache();
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.value;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const epoch = this.epoch;
    const promise = run()
      .then((value) => {
        if (epoch === this.epoch) {
          this.cache.set(key, { value, expires: Date.now() + ttl });
          this.pruneCache();
        }
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
  async identity(data) {
    const body = await this.call(
      {
        id: "validation",
        site: data.site,
        credentials: {
          accessKeyId: data.accessKeyId,
          accessKeySecret: data.accessKeySecret,
        },
      },
      "cn-hangzhou",
      "GetCallerIdentity",
      {},
      { product: "sts" },
    );
    if (!body.accountId) throw new Error("阿里云身份验证未返回 AccountId");
    return {
      cloudAccountId: body.accountId,
      principalId: body.principalId || body.userId || body.arn,
    };
  }
  regions(accountId) {
    return this.cached(
      "regions:" + (typeof accountId === "string" ? accountId : accountId.id),
      3600000,
      async () => {
        const b = await this.call(accountId, "cn-hangzhou", "DescribeRegions", {
          acceptLanguage: "zh-CN",
        });
        return list(b.regions?.region);
      },
    );
  }
  async instances(accountId, region, ids) {
    const items = [];
    for (let page = 1; page <= 200; page++) {
      const b = await this.call(accountId, region, "DescribeInstances", {
        regionId: region,
        pageNumber: page,
        pageSize: 100,
        ...(ids?.length ? { instanceIds: JSON.stringify(ids) } : {}),
      });
      const part = list(b.instances?.instance);
      items.push(...part);
      if (items.length >= (b.totalCount ?? items.length) || !part.length) break;
      if (page === 200) throw new Error("ECS 分页未完成，请缩小查询范围");
    }
    const a =
      typeof accountId === "string" ? this.store.account(accountId) : accountId;
    return items.map((i) => ({
      accountId: a.id,
      accountName: a.name,
      product: "ecs",
      region,
      id: i.instanceId,
      name: i.instanceName || i.instanceId,
      status: i.status,
      ip: [
        ...new Set(
          [
            ...list(i.publicIpAddress?.ipAddress),
            i.eipAddress?.ipAddress,
          ].filter(Boolean),
        ),
      ],
      privateIp: list(i.vpcAttributes?.privateIpAddress?.ipAddress),
      publicNetwork:
        i.eipAddress?.ipAddress || i.eipAddress?.allocationId ? "eip" : "ecs",
      eipAllocationId: i.eipAddress?.allocationId,
      planId: i.instanceType,
      cpu: i.cpu,
      memory: i.memory,
      expires: i.expiredTime,
      created: i.creationTime,
      chargeType: i.instanceChargeType,
      internetChargeType: i.internetChargeType,
      spotStrategy: i.spotStrategy,
      stoppedMode: i.stoppedMode,
      locked: list(i.operationLocks?.lockReason).length > 0,
    }));
  }
  async statuses(accountId, region, ids) {
    const output = [];
    const collect = async (batch, budget) => {
      if (budget.remaining <= 0) {
        output.push(
          ...batch.map((instanceId) => ({
            instanceId,
            error: "ECS 状态查询拆分次数已达上限，等待下轮重试",
          })),
        );
        return;
      }
      budget.remaining--;
      try {
        const items = await this.instances(accountId, region, batch);
        for (const instanceId of batch) {
          const i = items.find((i) => i.id === instanceId);
          output.push(
            i?.status
              ? { instanceId, status: i.status, instance: i }
              : { instanceId, error: "云端未返回 ECS 实例状态" },
          );
        }
      } catch (e) {
        // Only target-specific failures benefit from splitting; never amplify an outage or AccessDenied.
        if (
          batch.length > 1 &&
          /InvalidInstanceId|InvalidInstanceID|InvalidParameter\.InstanceIds/i.test(
            String(e.code || "") + " " + errorText(e),
          )
        ) {
          const middle = Math.floor(batch.length / 2);
          await collect(batch.slice(0, middle), budget);
          await collect(batch.slice(middle), budget);
        } else
          output.push(
            ...batch.map((instanceId) => ({ instanceId, error: errorText(e) })),
          );
      }
    };
    for (let n = 0; n < ids.length; n += 100)
      await collect(ids.slice(n, n + 100), { remaining: 32 });
    return output;
  }
  async instance(t) {
    return (await this.instances(t.accountId, t.region, [t.id]))[0];
  }
  async status(t) {
    const i = await this.instance(t);
    if (!i) throw new Error("云端未返回 ECS 实例状态");
    return i.status;
  }
  async usage(accountId, region, ids, { cycleCache } = {}) {
    const a =
      typeof accountId === "string" ? this.store.account(accountId) : accountId;
    // CDT is an account pool shared by every participating product and instance.
    // Cache once per account for a short interval, never per ECS instance.
    const month = zoned(new Date(), "Asia/Shanghai").month;
    const key = JSON.stringify(["cdt", a.id, month]);
    const read = () =>
      this.cached(key, 15000, async () => {
        const at = Date.now();
        const b = await this.call(
          a,
          "cn-hongkong",
          "ListCdtInternetTraffic",
          {},
          { product: "cdt" },
        );
        const rows = b.trafficDetails ?? b.data?.trafficDetails;
        if (!Array.isArray(rows) || rows.length === 0)
          throw new Error("CDT 未返回流量明细；请确认已开通并升级 CDT 计费");
        return { rows, at };
      });
    if (cycleCache && !cycleCache.has(key)) cycleCache.set(key, read());
    const result = await (cycleCache ? cycleCache.get(key) : read());
    if (result.rows.some((r) => !r.businessRegionId))
      throw new Error("CDT 未返回地域，无法校验流量池");
    const pool = trafficClass(region);
    const rows = result.rows.filter(
      (r) => trafficClass(r.businessRegionId || "") === pool,
    );
    if (
      rows.some(
        (r) =>
          !r.businessRegionId ||
          r.traffic == null ||
          r.traffic === "" ||
          !Number.isFinite(Number(r.traffic)) ||
          Number(r.traffic) < 0,
      )
    )
      throw new Error("CDT 流量明细无效，已停止执行流量规则");
    const used = rows.reduce((sum, r) => sum + Number(r.traffic), 0);
    const total = (pool === "china" ? 20 : 200) * 1024 ** 3;
    return ids.map((instanceId) => ({
      instanceId,
      trafficUsed: used,
      trafficPackageTotal: total,
      trafficPackageRemaining: Math.max(0, total - used),
      trafficOverflow: Math.max(0, used - total),
      at: result.at,
      pool,
      scope: "account",
    }));
  }
  async control(t, action, clientToken, { stoppedMode = "KeepCharging" } = {}) {
    if (!["start", "stop"].includes(action))
      throw new Error("只支持 ECS 开机与停机");
    if (!/^i-/.test(t.id))
      throw new Error("此 ID 不是 ECS 实例；请重新添加正确的 ECS 实例");
    if (!["KeepCharging", "StopCharging"].includes(stoppedMode))
      throw new Error("ECS 停机模式无效");
    return this.call(
      t.accountId,
      t.region,
      action === "start" ? "StartInstance" : "StopInstance",
      {
        regionId: t.region,
        instanceId: t.id,
        ...(action === "stop" ? { stoppedMode, forceStop: false } : {}),
      },
      { write: true },
    );
  }
  async monitor(t, metric, start, end, period = 3600) {
    if (period !== 3600) throw new Error("每日流量仅支持小时采样");
    const eip = monitorSource(t).startsWith("eip:");
    if (eip && !t.eipAllocationId)
      throw new Error("EIP 标识尚未同步，请刷新实例后重试");
    const points = await this.cached(
      JSON.stringify([
        "public-monitor-v2",
        t.accountId,
        t.region,
        monitorSource(t),
        start,
        end,
      ]),
      30000,
      async () => {
        const data = [];
        // EIP uses byte totals, ECS uses Kbit totals. The English EIP spec still
        // documents a 200-point limit; use that conservative bound, without retries on 4xx.
        const limit = eip ? 200 : 400;
        const earliest =
          Math.ceil((Date.now() - 30 * 86400000) / 3600000) * 3600000;
        for (
          let from = Math.max(start, earliest);
          from < end;
          from += limit * 3600000
        ) {
          const b = await this.call(
            t.accountId,
            t.region,
            eip ? "DescribeEipMonitorData" : "DescribeInstanceMonitorData",
            {
              ...(eip
                ? { regionId: t.region, allocationId: t.eipAllocationId }
                : { instanceId: t.id }),
              // Both APIs require UTC seconds without ISO fractional seconds.
              startTime: new Date(from).toISOString().replace(/\.\d{3}Z$/, "Z"),
              endTime: new Date(Math.min(end, from + limit * 3600000))
                .toISOString()
                .replace(/\.\d{3}Z$/, "Z"),
              period: 3600,
            },
            { product: eip ? "vpc" : "ecs" },
          ).catch((e) => {
            if (
              eip &&
              /Forbidden\.RAM|AccessDenied|Forbidden\.NoPermission/i.test(
                String(e.code || "") + " " + e.message,
              )
            )
              throw new Error(
                "EIP 流量监控无读取权限，请为此 EIP 授权 vpc:DescribeEipMonitorData",
                { cause: e },
              );
            throw e;
          });
          const rows = eip
            ? b.eipMonitorDatas?.eipMonitorData
            : b.monitorData?.instanceMonitorData;
          if (!Array.isArray(rows))
            throw new Error("监控接口未返回有效流量序列");
          data.push(...rows);
        }
        return data;
      },
    );
    return points.map((p) => {
      const value = eip
        ? metric === "INTERNET_IN"
          ? p.eipRX
          : p.eipTX
        : metric === "INTERNET_IN"
          ? p.internetRX
          : p.internetTX;
      return {
        timestamp: p.timeStamp,
        value:
          value == null || value === ""
            ? undefined
            : Number(value) * (eip ? 1 : 1024 / 8),
      };
    });
  }
  async billing(accountId, region, ids, cycle) {
    const [balance, rows] = await Promise.all([
      this.balance(accountId),
      this.billRows(accountId, cycle),
    ]);
    return {
      balance,
      items: rows.filter((x) => ids.includes(x.instanceID)),
      cycle,
      at: Date.now(),
    };
  }
  async balance(accountId) {
    const a = this.store.account(accountId),
      billRegion =
        a.site === "international" ? "ap-southeast-1" : "cn-hangzhou";
    const balance = await this.call(
      accountId,
      billRegion,
      "QueryAccountBalance",
      {},
      { product: "bss" },
    );
    if (
      !balance.data ||
      balance.data.availableAmount == null ||
      balance.data.availableAmount === "" ||
      !Number.isFinite(Number(balance.data.availableAmount))
    )
      throw new Error("余额接口未返回有效金额");
    return balance.data;
  }
  async billRows(accountId, cycle) {
    const a = this.store.account(accountId),
      billRegion =
        a.site === "international" ? "ap-southeast-1" : "cn-hangzhou";
    const items = [];
    let nextToken;
    for (let n = 0; n < 200; n++) {
      const b = await this.call(
        accountId,
        billRegion,
        "DescribeInstanceBill",
        {
          billingCycle: cycle,
          granularity: "MONTHLY",
          maxResults: 300,
          nextToken,
        },
        { product: "bss" },
      );
      items.push(...list(b.data?.items?.item ?? b.data?.items));
      if (!b.data) throw new Error("账单接口未返回数据");
      if (!b.data?.nextToken) return items;
      if (nextToken === b.data.nextToken) throw new Error("账单分页没有前进");
      nextToken = b.data.nextToken;
    }
    throw new Error("账单分页未完成");
  }
}
