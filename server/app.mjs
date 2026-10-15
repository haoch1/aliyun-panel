import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import * as V from "./validation.mjs";
import { errorText } from "./aliyun.mjs";
import { resourceKey } from "./store.mjs";
import { registerConnections } from "./connections.mjs";
import { BillingService, billingCycle } from "./billing.mjs";
export function createApp(
  { store, gateway, service, jobs, notify, engine },
  {
    dist = resolve("dist"),
    publicOrigin = process.env.PUBLIC_ORIGIN || "",
    testMode = false,
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "data:"],
          imgSrc: ["'self'", "data:"],
          upgradeInsecureRequests: publicOrigin.startsWith("https:")
            ? []
            : null,
        },
      },
      strictTransportSecurity: publicOrigin.startsWith("https:")
        ? undefined
        : false,
    }),
  );
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const expected = publicOrigin || `${req.protocol}://${req.headers.host}`;
      if (
        (req.headers.origin && req.headers.origin !== expected) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return res.status(403).json({ error: "请求来源不被允许" });
    }
    next();
  });
  const token = (req) =>
    /(?:^|;\s*)aliyun_panel_session=([a-f0-9]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
  const cookie = (res, s) =>
    res.cookie("aliyun_panel_session", s.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: publicOrigin.startsWith("https:"),
      path: "/",
      maxAge: s.expires - Date.now(),
    });
  const route = (method, path, fn) =>
    app[method](path, async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (e) {
        next(e);
      }
    });
  const tries = new Map();
  const authBody = z
    .object({
      password: z.string().min(1).max(200),
      sessionHours: z.number().int().min(12).max(2160).default(720),
    })
    .strict();
  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      service: "aliyun-panel",
      version: "0.1.0",
      testMode,
      heartbeat: store.get("health", "engine")?.at,
    }),
  );
  app.get("/api/auth", (req, res) => {
    const s = store.session(token(req));
    res.json({
      initialized: !!store.config("admin"),
      authenticated: !!s,
      csrf: s?.csrf,
      expires: s?.expires,
      testMode,
    });
  });
  for (const path of ["setup", "login"])
    route("post", "/api/" + path, (req, res) => {
      const key = req.socket.remoteAddress || "local",
        old = tries.get(key) || { count: 0, until: 0 };
      if (old.until > Date.now() && old.count >= 10)
        throw Object.assign(new Error("尝试过多，请稍后重试"), { status: 429 });
      const n =
        old.until > Date.now()
          ? { ...old, count: old.count + 1 }
          : { count: 1, until: Date.now() + 600000 };
      tries.set(key, n);
      if (tries.size > 2000)
        for (const [k, v] of tries) if (v.until < Date.now()) tries.delete(k);
      const data = authBody.parse(req.body);
      if (path === "setup") {
        if (store.config("admin"))
          throw Object.assign(new Error("面板已初始化"), { status: 409 });
        if (data.password.length < 12) throw new Error("管理员密码至少 12 位");
        store.setPassword(data.password);
      } else if (!store.verifyPassword(data.password))
        throw Object.assign(new Error("密码不正确"), { status: 401 });
      tries.delete(key);
      const s = store.createSession(data.sessionHours);
      cookie(res, s);
      res.json({ csrf: s.csrf, expires: s.expires });
    });
  app.use("/api", (req, res, next) => {
    const s = store.session(token(req));
    if (!s) return res.status(401).json({ error: "请先登录" });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers["x-csrf-token"] !== s.csrf
    )
      return res.status(403).json({ error: "会话校验失败，请重新登录" });
    req.panelSession = s;
    next();
  });
  const billing = engine.billing || new BillingService(store, gateway, service);
  registerConnections(route, { store, gateway, service, jobs });
  route("post", "/api/logout", (req, res) => {
    store.deleteSession(token(req));
    res.clearCookie("aliyun_panel_session", { path: "/" });
    res.json({ ok: true });
  });
  route("post", "/api/session", (req, res) => {
    const hours = z.number().int().min(12).max(2160).parse(req.body.hours),
      s = store.renewSession(token(req), hours);
    cookie(res, { token: token(req), expires: s.expires });
    res.json(s);
  });
  route("get", "/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const event = (type) =>
      res.write("data: " + JSON.stringify({ type }) + "\n\n");
    store.onEvent.add(event);
    const timer = setInterval(() => {
      if (!store.sessionByHash(req.panelSession.hash)) res.end();
      else res.write(": heartbeat\n\n");
    }, 15000);
    req.on("close", () => {
      clearInterval(timer);
      store.onEvent.delete(event);
    });
    event("connected");
  });
  route("get", "/api/accounts", (_req, res) =>
    res.json({
      items: store.accounts().map((a) => {
        const scopes = store.list("scope").filter((s) => s.accountId === a.id);
        return {
          ...a,
          accessStatus: scopes.some((s) => s.error)
            ? "error"
            : scopes.length
              ? "readable"
              : "pending",
          accessError: scopes
            .filter((s) => s.error)
            .map((s) => s.error)
            .join("；"),
        };
      }),
    }),
  );
  route("get", "/api/regions", async (req, res) =>
    res.json({
      items: await gateway.regions(z.string().parse(req.query.accountId)),
    }),
  );
  route("get", "/api/instances", (req, res) =>
    res.json(service.instances(req.query)),
  );
  route("post", "/api/refresh", async (req, res) => {
    const { check, ...filter } = z
      .object({
        accountId: z.string().optional(),
        region: V.region.or(z.literal("all")).optional(),
        check: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    if (check) {
      await engine.cycle(true, filter);
      await jobs.tick();
    } else await service.refresh(filter);
    res.json(service.instances(filter));
  });
  route("put", "/api/keepalive", (req, res) => {
    const v = z
      .object({ target: V.target, keepAlive: z.boolean().nullable() })
      .strict()
      .parse(req.body);
    const i = service.instance(v.target);
    if (!i) throw new Error("实例未纳入监控");
    const rule = store.saveRule(v.target, { keepAlive: v.keepAlive });
    store.audit({
      account: v.target.accountId,
      target: v.target.id,
      action: "keepalive-update",
      detail:
        "保活设置：" +
        (v.keepAlive === null
          ? "跟随全局默认"
          : v.keepAlive
            ? "单独开启"
            : "单独关闭"),
      context: {
        instanceName: i.name,
        accountName: i.accountName,
        region: i.region,
        rule,
      },
    });
    res.json(rule);
  });
  route("put", "/api/rules", async (req, res) => {
    const t = V.target.parse(req.body.target),
      v = V.ruleInput.parse(req.body.rule);
    store.account(t.accountId);
    const i = await service.refreshTarget(t, { usage: v.thresholdEnabled });
    if (v.thresholdEnabled && i.usage?.quota !== "finite")
      throw new Error("CDT 流量不可校验，不能启用流量保护");
    const rule = store.saveRule(t, v);
    store.audit({
      account: t.accountId,
      action: "rule-update",
      target: t.id,
      context: {
        instanceName: i.name,
        accountName: i.accountName,
        region: t.region,
        rule,
      },
      detail: `保活 ${rule.keepAlive === null ? "跟随全局" : rule.keepAlive ? "启用" : "关闭"}；定时 ${v.scheduleEnabled ? "启用" : "关闭"}；流量保护 ${v.thresholdEnabled ? "启用" : "关闭"}`,
    });
    res.json(rule);
  });
  for (const [kind, fields] of Object.entries({
    traffic: [
      "thresholdEnabled",
      "thresholdPercent",
      "thresholdAction",
      "thresholdUnit",
      "thresholdGiB",
      "autoRecover",
      "stoppedMode",
    ],
    schedule: [
      "scheduleEnabled",
      "scheduleStopEnabled",
      "start",
      "stop",
      "timezone",
      "stoppedMode",
    ],
  }))
    route("put", "/api/rules/" + kind, async (req, res) => {
      const t = V.target.parse(req.body.target);
      const shape = Object.fromEntries(
        fields.map((k) => [k, V.ruleInput.shape[k]]),
      );
      const changes = z.object(shape).strict().parse(req.body.rule);
      const merged = V.ruleInput.parse({
        ...Object.fromEntries(
          Object.keys(V.ruleInput.shape).map((k) => [k, store.rule(t)[k]]),
        ),
        ...changes,
      });
      const i = await service.refreshTarget(t, {
        usage: merged.thresholdEnabled,
      });
      if (
        merged.thresholdEnabled &&
        (i.usage?.quota !== "finite" || i.usage?.error)
      )
        throw new Error("CDT 流量不可校验，不能启用流量保护");
      const rule = store.saveRule(t, changes);
      store.audit({
        account: t.accountId,
        target: t.id,
        action: "rule-update",
        category: "automation",
        detail: (kind === "traffic" ? "流量保护" : "定时关机") + "设置已保存",
        context: { instanceName: i.name, region: t.region, rule },
      });
      res.json(rule);
    });
  route("post", "/api/operations", async (req, res) => {
    const { action, override, stoppedMode, ...t } = V.operationInput.parse(
      req.body,
    );
    res
      .status(202)
      .json(await jobs.manual(t, action, { override, stoppedMode }));
  });
  route("get", "/api/jobs", (_req, res) =>
    res.json({
      items: store
        .list("job")
        .slice(-100)
        .reverse()
        .map((j) => jobs.public(j)),
    }),
  );
  route("post", "/api/jobs/:id/recheck", (req, res) => {
    const j = store.get("job", req.params.id);
    if (!j || j.status !== "attention") throw new Error("此任务不需要核对");
    store.put("job", j.id, {
      ...j,
      status: "submitted",
      submittedAt: Date.now(),
    });
    res.json({ ok: true });
  });
  route("get", "/api/traffic", async (req, res) => {
    const { days, ...q } = req.query;
    const t = V.target.parse(q);
    res.json(
      await service.traffic(
        t,
        days === "month"
          ? "month"
          : z.coerce
              .number()
              .int()
              .min(1)
              .max(30)
              .parse(days || 7),
      ),
    );
  });
  route("get", "/api/settings", (_req, res) =>
    res.json(store.publicSettings()),
  );
  route("put", "/api/settings", (req, res) => {
    const v = V.settingsInput.parse(req.body),
      old = store.settings().notifications,
      n = v.notifications;
    const base = new URL(n.apiBase);
    if (
      !["https:", "http:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error("TG API 地址须为有效 HTTP(S) 根地址");
    if (!n.telegramToken) n.telegramToken = old.telegramToken;
    store.saveSettings(v);
    store.audit({
      action: "settings-update",
      detail: "监控和通知设置已保存",
      context: {
        checkInterval: v.checkInterval,
        billingEnabled: v.billingEnabled,
        billingInterval: v.billingInterval,
        telegramEnabled: n.telegramEnabled,
        events: store.publicSettings().notifications.events,
        dailyReport: store.settings().dailyReport,
      },
    });
    res.json(store.publicSettings());
  });
  route("post", "/api/notifications/test", (_req, res) =>
    res.json({ channels: notify.test() }),
  );
  route("get", "/api/notifications", (_req, res) =>
    res.json({
      items: store.list("outbox").slice(-50).reverse(),
      at: Date.now(),
    }),
  );
  route("get", "/api/billing", (_req, res) =>
    res.json(
      billing.view(
        V.cycle.parse(_req.query.cycle || billingCycle()),
        _req.query.accountId || "all",
      ),
    ),
  );
  route("post", "/api/billing/refresh", async (req, res) => {
    const v = z
      .object({
        cycle: V.cycle.default(billingCycle()),
        accountId: z.string().default("all"),
      })
      .strict()
      .parse(req.body);
    res.json(await billing.refresh({ ...v, force: true }));
  });
  route("post", "/api/check", async (_req, res) => {
    await engine.cycle(true);
    await jobs.tick();
    res.json({ ok: true });
  });
  route("get", "/api/audit", (_req, res) =>
    res.json({ items: store.logs(), at: Date.now() }),
  );
  route("delete", "/api/audit", (_req, res) =>
    res.json({ deleted: store.clearLogs() }),
  );
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use((e, req, res, _next) => {
    let message =
      e instanceof z.ZodError
        ? e.issues.map((x) => x.message).join("；")
        : errorText(
            e,
            [
              req.body?.accessKeyId,
              req.body?.accessKeySecret,
              req.body?.password,
              req.body?.notifications?.telegramToken,
            ].filter(Boolean),
          );
    if (store.session(token(req)))
      store.audit({
        action: "request-error",
        status: "failed",
        level: "error",
        detail: message,
        context: {
          endpoint: req.path,
          method: req.method,
          requestId: e.data?.requestId || e.requestId,
        },
      });
    res
      .status(e instanceof z.ZodError ? 400 : e.status || 400)
      .json({ error: message });
  });
  if (existsSync(resolve(dist, "index.html"))) {
    app.use(express.static(dist));
    app.use((req, res) => res.sendFile(resolve(dist, "index.html")));
  }
  return app;
}
