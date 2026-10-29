import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mapLimit } from "./service.mjs";
import { errorText } from "./aliyun.mjs";
import { resourceKey } from "./store.mjs";
import * as V from "./validation.mjs";
export function registerConnections(route, { store, gateway, service, jobs }) {
  const scans = new Map();
  route("post", "/api/connections/regions", async (req, res) => {
    const data = z
      .object({
        accessKeyId: z.string().min(1).max(128),
        accessKeySecret: z.string().min(1).max(256),
        site: z.enum(["china", "international"]),
      })
      .strict()
      .parse(req.body);
    const a = {
      id: "region-options:" + randomUUID(),
      site: data.site,
      credentials: {
        accessKeyId: data.accessKeyId,
        accessKeySecret: data.accessKeySecret,
      },
    };
    try {
      // No credentials or temporary SDK clients persist after this read.
      const items = await gateway.regions(a);
      res.json({
        items: items.map((r) => ({
          regionId: r.regionId,
          localName: r.localName,
        })),
      });
    } finally {
      for (const key of gateway.clients.keys())
        if (JSON.parse(key)[1] === a.id) gateway.clients.delete(key);
    }
  });
  route("post", "/api/connections/discover", async (req, res) => {
    for (const [id, scan] of scans)
      if (scan.until < Date.now()) scans.delete(id);
    if (scans.size >= 10) throw new Error("发现请求过多，请稍后重试");
    const data = z
      .object({
        name: z.string().trim().min(1, "实例名称必填").max(80),
        accessKeyId: z.string().min(1).max(128),
        accessKeySecret: z.string().min(1).max(256),
        site: z.enum(["china", "international"]),
        region: z.union([V.region, z.literal("")]).default(""),
        instanceId: z
          .string()
          .trim()
          .regex(/^i-[\w-]+$/, "请填写 ECS 实例 ID（i- 开头）")
          .max(128),
      })
      .strict()
      .parse(req.body);
    const identity = await gateway.identity(data),
      token = randomUUID();
    const a = {
      id: "scan:" + token,
      name: data.name || "接入实例",
      site: data.site,
      credentials: {
        accessKeyId: data.accessKeyId,
        accessKeySecret: data.accessKeySecret,
      },
    };
    const errors = [];
    let items, availableRegions;
    try {
      availableRegions = await gateway.regions(a);
      if (
        data.region &&
        !availableRegions.some((r) => r.regionId === data.region)
      )
        throw new Error("此地域不在阿里云 ECS 支持列表中");
      const regions = data.region
        ? availableRegions.filter((r) => r.regionId === data.region)
        : availableRegions;
      let located = false;
      items = (
        await mapLimit(regions, 3, async (r) => {
          if (located) return [];
          try {
            const matches = (
              await gateway.instances(a, r.regionId, [data.instanceId])
            ).filter((i) => !data.instanceId || i.id === data.instanceId);
            if (matches.length) located = true;
            return matches;
          } catch (e) {
            const detail = errorText(e, Object.values(a.credentials));
            errors.push(
              r.regionId +
                "：" +
                (/ENOTFOUND|EAI_AGAIN/.test(detail)
                  ? "域名解析暂时失败"
                  : /ETIMEDOUT|ESOCKETTIMEDOUT|timeout/i.test(detail)
                    ? "连接超时"
                    : detail
                        .split(/(?:POST|GET) https?:\/\//)[0]
                        .slice(0, 240)),
            );
            return [];
          }
        })
      ).flat();
    } finally {
      gateway.invalidate();
    }
    if (!items.length && !errors.length)
      throw new Error("未找到ECS 实例，请核对地域、实例 ID 和 AccessKey 权限");
    scans.set(token, {
      data,
      identity,
      items,
      until: Date.now() + 600000,
      session: req.panelSession.hash,
    });
    // Only cloud metadata is returned; credentials stay in server memory until import.
    res.json({
      token,
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        region: i.region,
        status: i.status,
        ip: i.ip,
      })),
      errors,
      regions: availableRegions.map((r) => ({
        regionId: r.regionId,
        localName: r.localName,
      })),
    });
  });
  route("post", "/api/connections/import", async (req, res) => {
    const v = z
      .object({
        token: z.uuid(),
        targets: z
          .array(
            z
              .object({
                region: V.region,
                id: z.string().min(1).max(128),
                name: z.string().trim().max(80).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(200),
        keepAlive: z.boolean().nullable().default(null),
      })
      .strict()
      .parse(req.body);
    const scan = scans.get(v.token);
    if (
      !scan ||
      scan.until < Date.now() ||
      scan.session !== req.panelSession.hash
    )
      throw new Error("发现结果已过期，请重新发现");
    if (
      v.targets.some(
        (t) => !scan.items.some((i) => i.id === t.id && i.region === t.region),
      )
    )
      throw new Error("选择的实例不在发现结果中");
    const { data, identity } = scan;
    if (
      data.name &&
      new Set(v.targets.map((t) => t.region + "|" + t.id)).size > 1 &&
      v.targets.some((t) => t.name == null)
    )
      throw new Error("发现多台实例，请分别确认每台实例的名称");
    const existing = store.accounts().find((meta) => {
      const a = store.account(meta.id);
      return (
        a.site === data.site &&
        a.credentials.accessKeyId === data.accessKeyId &&
        a.credentials.accessKeySecret === data.accessKeySecret
      );
    });
    const existingTargets =
      existing?.monitors ??
      (existing
        ? service
            .instances({ accountId: existing.id })
            .items.map((i) => ({ id: i.id, region: i.region }))
        : []);
    const targets = [
      ...new Map(
        v.targets.map((t) => [JSON.stringify([t.region, t.id]), t]),
      ).values(),
    ];
    for (const t of targets) {
      t.name ||= targets.length === 1 ? data.name || undefined : undefined;
    }
    const added = targets.filter(
      (t) =>
        !existingTargets.some((x) => x.id === t.id && x.region === t.region),
    );
    const saved = store.saveAccount(
      {
        ...existing,
        ...identity,
        name: existing?.name || "阿里云账号 · " + identity.cloudAccountId,
        site: data.site,
        region: v.targets[0].region,
        accessKeyId: data.accessKeyId,
        keyTail: data.accessKeyId.slice(-4),
        monitors: [...existingTargets, ...added],
      },
      { accessKeyId: data.accessKeyId, accessKeySecret: data.accessKeySecret },
      existing?.id,
    );
    for (const t of added)
      store.saveRule({ ...t, accountId: saved.id }, { keepAlive: v.keepAlive });
    scans.delete(v.token);
    gateway.invalidate();
    await service.refresh({ accountId: saved.id });
    await service.captureTraffic({ accountId: saved.id });
    store.audit({
      account: saved.id,
      action: "monitor-add",
      detail: `已添加 ${added.length} 台已有ECS 实例`,
      context: {
        accountName: saved.name,
        site: data.site,
        monitors: added,
        keepAlive: v.keepAlive,
      },
    });
    res.json({
      added: added.length,
      existing: targets.length - added.length,
      accountId: saved.id,
    });
  });
  route("get", "/api/connections/:id", (req, res) => {
    const { credentials, ...meta } = store.account(req.params.id);
    res.json({
      ...meta,
      accessKeyId: credentials.accessKeyId,
      secretConfigured: !!credentials.accessKeySecret,
    });
  });
  route("put", "/api/connections/:id", async (req, res) => {
    const old = store.account(req.params.id),
      data = V.accountInput
        .extend({
          instance: z
            .object({
              target: V.target,
              name: z.string().trim().min(1).max(80),
            })
            .strict()
            .optional(),
        })
        .parse(req.body);
    const { instance } = data;
    if (
      instance &&
      (instance.target.accountId !== old.id ||
        !service.instance(instance.target))
    )
      throw new Error("此实例未纳入该账号的监控");
    const monitored =
      old.monitors ||
      service
        .instances({ accountId: old.id })
        .items.map((i) => ({ id: i.id, region: i.region }));
    const monitors = instance
      ? monitored.map((m) =>
          m.id === instance.target.id && m.region === instance.target.region
            ? { ...m, name: instance.name }
            : m,
        )
      : old.monitors;
    data.accessKeySecret ||= old.credentials.accessKeySecret;
    const identity = await gateway.identity(data);
    if (identity.cloudAccountId !== old.cloudAccountId)
      throw new Error("新凭证属于另一账号，请通过添加实例重新接入");
    const { credentials, ...meta } = old;
    store.saveAccount(
      {
        ...meta,
        ...identity,
        name: data.name,
        site: data.site,
        region: data.region,
        monitors,
        accessKeyId: data.accessKeyId,
        keyTail: data.accessKeyId.slice(-4),
      },
      { accessKeyId: data.accessKeyId, accessKeySecret: data.accessKeySecret },
      old.id,
    );
    if (
      old.site !== data.site ||
      credentials.accessKeyId !== data.accessKeyId ||
      credentials.accessKeySecret !== data.accessKeySecret
    )
      for (const b of store
        .list("billing")
        .filter((b) => b.accountId === old.id))
        store.remove("billing", JSON.stringify([old.id, b.cycle]));
    gateway.invalidate();
    await service.refresh({ accountId: old.id });
    store.audit({
      account: old.id,
      action: "connection-update",
      context: {
        accountName: data.name,
        site: data.site,
        monitors,
        instanceName: instance?.name,
      },
      detail: "接入凭证及账单站点已更新",
    });
    res.json({ ok: true });
  });
  route("delete", "/api/monitors", async (req, res) => {
    const t = V.target.parse(req.body);
    if (jobs.busy(t))
      throw Object.assign(new Error("实例操作尚未完成，核对后再移除监控"), {
        status: 409,
      });
    const a = store.account(t.accountId),
      { credentials, ...meta } = a;
    const all =
      a.monitors ??
      service
        .instances({ accountId: a.id })
        .items.map((i) => ({ region: i.region, id: i.id }));
    if (!all.some((x) => x.id === t.id && x.region === t.region))
      throw new Error("此实例未接入监控");
    service.history.close(t);
    const monitors = all.filter((x) => x.id !== t.id || x.region !== t.region);
    if (monitors.length)
      store.saveAccount({ ...meta, monitors }, credentials, a.id);
    else store.deleteAccount(a.id);
    for (const s of store.list("scope").filter((s) => s.accountId === a.id))
      store.put("scope", JSON.stringify([s.accountId, s.region]), {
        ...s,
        items: s.items.filter((i) => i.id !== t.id || i.region !== t.region),
      });
    store.remove("rule", resourceKey(t));
    store.audit({
      account: a.id,
      action: "monitor-remove",
      context: { accountName: a.name, region: t.region },
      target: t.id,
      detail: "仅移除本地监控，云端实例保持原状",
    });
    res.json({ ok: true });
  });
}
