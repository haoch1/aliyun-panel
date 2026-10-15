import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { fixture } from "./fixture.mjs";
import { createApp } from "../server/app.mjs";
import { defaultRule } from "../server/store.mjs";
import { billKey, billingCycle } from "../server/billing.mjs";
import { decide, nextSchedule, zoned } from "../server/policy.mjs";
import { telegramText, telegramRequest } from "../server/notify.mjs";
function runtime(t) {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-test-")),
    r = fixture(dir);
  t.after(() => {
    r.store.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + "aliyun-test-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  return r;
}
async function http(t, r) {
  const server = createServer(createApp(r, { dist: "not-built" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port;
  const login = await fetch(url + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "fixture-password-123" }),
  });
  const auth = await login.json(),
    headers = {
      cookie: login.headers.get("set-cookie").split(";")[0],
      "x-csrf-token": auth.csrf,
      "content-type": "application/json",
    };
  return async (path, body, method = body === undefined ? "GET" : "POST") => {
    const res = await fetch(url + "/api" + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  };
}
const target = {
  accountId: "account-test",
  region: "cn-hongkong",
  id: "i-data",
};
test("刷新接口只读，执行自动化才会启动保活和流量关机", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  const running = { ...target, id: "i-web" };
  r.store.saveRule(target, { keepAlive: true });
  r.store.saveRule(running, { thresholdEnabled: true, thresholdPercent: 1 });
  for (let n = 0; n < 2; n++) {
    assert.equal(
      (
        await request("/refresh", {
          accountId: target.accountId,
          region: "all",
        })
      ).status,
      200,
    );
    assert.equal((await request("/instances")).status, 200);
  }
  assert.equal(r.state.get(target.id), "Stopped");
  assert.equal(r.state.get(running.id), "Running");
  assert.equal(r.store.list("job").length, 0);
  assert.ok(r.calls.every((c) => !c.options.write));
  assert.equal(r.store.rule(target).lastCheck, undefined);
  assert.equal(r.store.rule(running).hold, undefined);
  assert.equal((await request("/check", {})).status, 200);
  assert.ok(
    r.calls.some(
      (c) => c.action === "StartInstance" && c.params.instanceId === target.id,
    ),
  );
  assert.ok(
    r.calls.some(
      (c) => c.action === "StopInstance" && c.params.instanceId === running.id,
    ),
  );
  assert.equal(r.state.get(target.id), "Running");
  assert.equal(r.state.get(running.id), "Stopped");
  assert.equal(r.store.rule(running).hold, "traffic");
});
test("AccessKey 指定 ECS 跨地域查询只读，导入去重且其他实例不受监控", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  const d = await request("/connections/discover", {
    accessKeyId: "new-key",
    accessKeySecret: "new-secret",
    site: "international",
    name: "边缘服务",
    instanceId: "i-edge",
  });
  assert.equal(d.status, 200);
  assert.equal(d.data.items.length, 1);
  assert.ok(!JSON.stringify(d.data).includes("new-secret"));
  assert.ok(r.calls.every((c) => !c.options.write));
  const choice = { id: "i-edge", region: "cn-hangzhou" };
  const imported = await request("/connections/import", {
    token: d.data.token,
    targets: [choice, choice],
    keepAlive: true,
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.added, 1);
  const id = imported.data.accountId;
  assert.equal(r.store.account(id).site, "international");
  assert.equal(r.store.account(id).monitors.length, 1);
  assert.deepEqual(
    r.service.instances({ accountId: id }).items.map((i) => i.id),
    ["i-edge"],
  );
  assert.equal(r.store.rule({ ...choice, accountId: id }).keepAlive, true);
  assert.equal(
    (
      await request("/connections/import", {
        token: d.data.token,
        targets: [choice],
      })
    ).status,
    400,
  );
  await assert.rejects(
    r.service.refreshTarget({
      accountId: id,
      region: "cn-hongkong",
      id: "i-web",
    }),
    /未接入/,
  );
  const removed = await request(
    "/monitors",
    { ...choice, accountId: id },
    "DELETE",
  );
  assert.equal(removed.status, 200);
  assert.equal(r.state.get("i-edge"), "Running");
  assert.ok(r.calls.every((c) => !c.options.write));
});
test("编辑凭证留空保留 Secret，站点切换清除旧币种账单，已移除路由不可调用", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  await r.service.refresh();
  await r.engine.billing.refresh({ force: true });
  assert.ok(r.store.get("billing", billKey(target.accountId, billingCycle())));
  const config = (await request("/connections/" + target.accountId)).data;
  assert.equal(config.accessKeyId, "fixture-key");
  assert.equal(config.credentials, undefined);
  assert.equal(config.accessKeySecret, undefined);
  const updated = await request(
    "/connections/" + target.accountId,
    {
      name: "国际凭证",
      accessKeyId: "fixture-key",
      accessKeySecret: "",
      site: "international",
      region: "cn-hongkong",
    },
    "PUT",
  );
  assert.equal(updated.status, 200);
  assert.equal(
    r.store.account(target.accountId).credentials.accessKeySecret,
    "fixture-secret",
  );
  assert.equal(
    r.store.get("billing", billKey(target.accountId, billingCycle())),
    null,
  );
  for (const path of [
    "/launch",
    "/firewall",
    "/keys",
    "/command",
    "/terminal",
    "/accounts",
  ])
    assert.equal((await request(path, {})).status, 404, path);
  assert.equal(
    (await request("/operations", { ...target, action: "reboot" })).status,
    400,
  );
});
test("账单和余额独立成功；失败保留金额，缓存跨地域去重和强制刷新", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.gateway.balance = async () => {
    throw new Error("余额权限不足");
  };
  let bills = 0;
  r.gateway.billRows = async () => {
    bills++;
    return [
      { instanceID: "i-data", pretaxAmount: "12.5", currency: "CNY" },
      { instanceID: "i-data", pretaxAmount: "3", currency: "CNY" },
    ];
  };
  let view = await r.engine.billing.refresh();
  assert.equal(bills, 1);
  let account = view.items[0];
  assert.match(account.balanceError, /权限/);
  assert.equal(account.instances.find((i) => i.id === "i-data").amount, 15.5);
  assert.equal(account.instances.find((i) => i.id === "i-web").amount, 0);
  await r.engine.billing.refresh();
  assert.equal(bills, 1);
  r.gateway.balance = async () => ({ availableAmount: "50", currency: "CNY" });
  r.gateway.billRows = async () => {
    bills++;
    throw new Error("账单临时失败");
  };
  view = await r.engine.billing.refresh({ force: true });
  account = view.items[0];
  assert.equal(account.balance.availableAmount, "50");
  assert.equal(account.instances.find((i) => i.id === "i-data").amount, 15.5);
  assert.equal(account.stale, true);
  assert.match(account.billError, /失败/);
  assert.equal(bills, 2);
});
test("国际站 BSS 端点及区域切换；延迟账单不能覆盖凭证变更后的数据", async (t) => {
  const r = runtime(t),
    a = r.store.account(target.accountId),
    { credentials, ...meta } = a;
  r.store.saveAccount({ ...meta, site: "international" }, credentials, a.id);
  assert.equal(
    r.gateway.client("bss", r.store.account(a.id), "ap-southeast-1")._endpoint,
    "business.ap-southeast-1.aliyuncs.com",
  );
  await r.gateway.balance(a.id);
  assert.equal(r.calls.at(-1).region, "ap-southeast-1");
  assert.equal(
    r.gateway.client("bss", { ...a, site: "china" }, "cn-hangzhou")._endpoint,
    "business.aliyuncs.com",
  );
  let release;
  r.gateway.billRows = () => new Promise((resolve) => (release = resolve));
  const pending = r.engine.billing.refresh({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  r.store.saveAccount({ ...meta, site: "china" }, credentials, a.id);
  release([{ instanceID: "i-data", pretaxAmount: 9, currency: "USD" }]);
  await pending;
  assert.equal(r.store.get("billing", billKey(a.id, billingCycle())), null);
});
test("GiB 熔断可选安全恢复，人工锁定与未知流量不会被自动解除", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.store.saveRule(target, {
    keepAlive: true,
    hold: "traffic",
    autoRecover: true,
    thresholdEnabled: true,
    thresholdUnit: "gib",
    thresholdGiB: 120,
  });
  await r.engine.cycle(true);
  assert.equal(r.store.rule(target).hold, undefined);
  const j = r.store.list("job").find((j) => j.source === "keepalive");
  assert.ok(j);
  await r.jobs.run(j);
  r.store.saveRule(target, { hold: "manual", thresholdGiB: 1 });
  await r.engine.cycle(true);
  assert.equal(r.store.rule(target).hold, "manual");
  const rule = {
    ...defaultRule(target),
    keepAlive: true,
    hold: "traffic",
    autoRecover: true,
    thresholdEnabled: true,
  };
  assert.equal(
    decide(
      {
        status: "Stopped",
        usage: {
          quota: "finite",
          used: 0,
          total: 200,
          at: Date.now(),
          error: "temporary",
        },
      },
      rule,
      {},
    ).action,
    undefined,
  );
  assert.equal(
    decide(
      {
        status: "Running",
        usage: { quota: "finite", used: 200, total: 200, at: Date.now() },
      },
      { ...rule, hold: "manual" },
      {},
    ).latch,
    undefined,
  );
});
test("每日下一次动作正确处理跨午夜及夏令时跳变", () => {
  const r = {
    ...defaultRule(target),
    scheduleEnabled: true,
    start: "22:00",
    stop: "06:00",
  };
  let next = nextSchedule(r, new Date("2026-10-14T23:30:42+08:00"));
  assert.equal(next.nextAction, "stop");
  assert.equal(next.nextAt, "2026-10-14T22:00:00.000Z");
  next = nextSchedule(
    { ...r, timezone: "America/New_York", start: "02:30", stop: "04:00" },
    new Date("2026-03-08T01:59:00-05:00"),
  );
  assert.equal(next.nextAction, "start");
  assert.equal(next.nextAt, "2026-03-08T07:00:00.000Z");
  assert.equal(
    decide(
      { status: "Stopped" },
      {
        ...r,
        keepAlive: false,
        timezone: "America/New_York",
        start: "02:30",
        stop: "04:00",
      },
      {},
      { now: Date.parse("2026-03-08T03:05:00-04:00") },
    ).action,
    "start",
  );
});
test("长检测间隔仍在每日开机边界检查和提交定时操作", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const settings = r.store.settings();
  settings.checkInterval = 3600;
  r.store.saveSettings(settings);
  const local = zoned(new Date(), "Asia/Shanghai"),
    minutes =
      Number(local.clock.slice(0, 2)) * 60 + Number(local.clock.slice(3));
  const stopMinutes = (minutes + 60) % 1440,
    stop =
      String(Math.floor(stopMinutes / 60)).padStart(2, "0") +
      ":" +
      String(stopMinutes % 60).padStart(2, "0");
  r.store.saveRule(target, {
    keepAlive: false,
    scheduleEnabled: true,
    start: local.clock,
    stop,
  });
  r.engine.lastCycle = Date.now();
  r.engine.lastMonth = local.month;
  await r.engine.cycle();
  const job = r.store.list("job").find((j) => j.instanceId === target.id);
  assert.equal(job.source, "schedule");
  assert.equal(job.action, "start");
});
test("TG 消息精简、HTML 转义、模式筛选；关闭后跳过待发送事件但允许测试", async (t) => {
  const r = runtime(t),
    s = r.store.settings();
  delete s.notifications.events;
  Object.assign(s.notifications, {
    telegramToken: "fixture-token",
    telegramChatId: "fixture-chat",
    mode: "errors",
  });
  r.store.saveSettings(s);
  r.notify.event("good", "开机", "成功");
  r.notify.event("bad", "流量关机失败", "temporary", {
    level: "error",
    instance: {
      name: "<Web>&",
      region: "cn-hongkong",
      usage: { used: 1024 ** 3, total: 200 * 1024 ** 3 },
    },
  });
  assert.equal(r.store.list("outbox").length, 1);
  const message = telegramText(r.store.list("outbox")[0]);
  assert.match(message, /&lt;Web&gt;&amp;/);
  assert.match(message, /1.0 \/ 200.0 GB/);
  assert.ok(message.split("\n").filter(Boolean).length <= 6);
  assert.match(message, /<blockquote><b>🇭🇰/);
  assert.equal((message.match(/🕒/g) || []).length, 1);
  s.notifications.mode = "off";
  r.store.saveSettings(s);
  r.notify.event("daily", "日报", "不会发送", { kind: "report" });
  await r.notify.tick();
  assert.equal(r.store.list("outbox")[0].status, "skipped");
  assert.deepEqual(r.notify.test(), ["telegram"]);
  await r.notify.tick();
  assert.equal(r.store.list("outbox").at(-1).status, "sent");
  assert.equal(r.store.publicSettings().notifications.telegramToken, "");
  assert.equal(r.store.settings().notifications.webhook, undefined);
});
test("TG HTTP 传输使用 sendMessage，保留中文正文并检查业务返回", async (t) => {
  const proxyKeys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  const oldProxy = Object.fromEntries(
    proxyKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of proxyKeys) delete process.env[key];
  process.env.NO_PROXY = "127.0.0.1";
  t.after(() => {
    for (const key of proxyKeys) {
      if (oldProxy[key] === undefined) delete process.env[key];
      else process.env[key] = oldProxy[key];
    }
  });
  let captured;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured = { path: req.url, data: JSON.parse(body) };
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await telegramRequest(
    {
      apiBase: "http://127.0.0.1:" + server.address().port,
      telegramToken: "fake-token",
    },
    { chat_id: "fake-chat", text: "保活成功", parse_mode: "HTML" },
  );
  assert.equal(captured.path, "/botfake-token/sendMessage");
  assert.equal(captured.data.text, "保活成功");
});
test("保活开关独立保存，默认开启不覆盖已关闭的实例及停机保护", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  await r.service.refresh();
  r.store.saveRule(target, {
    keepAlive: true,
    hold: "manual",
    thresholdEnabled: true,
    scheduleEnabled: true,
    lastCheck: "2026-10-14T11:00:00Z",
  });
  const prior = r.store.rule(target),
    calls = r.calls.length;
  assert.equal(
    (await request("/keepalive", { target, keepAlive: false }, "PUT")).status,
    200,
  );
  const changed = r.store.rule(target);
  for (const k of [
    "hold",
    "thresholdEnabled",
    "thresholdPercent",
    "scheduleEnabled",
    "start",
    "stop",
    "lastCheck",
  ])
    assert.equal(changed[k], prior[k]);
  assert.equal(r.calls.length, calls);
  assert.equal(
    (await request("/keepalive", { target, keepAlive: "true" }, "PUT")).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/keepalive",
        { target: { ...target, id: "not-monitored" }, keepAlive: true },
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/settings",
        { ...r.store.settings(), keepAliveDefault: true },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(r.service.instance(target).effectiveKeepAlive, false);
  assert.equal(
    r.service.instance({ ...target, id: "i-web" }).effectiveKeepAlive,
    false,
  );
  assert.equal(
    (await request("/keepalive", { target, keepAlive: null }, "PUT")).status,
    200,
  );
  assert.equal(r.service.instance(target).effectiveKeepAlive, true);
  const rule = { ...defaultRule(target), paused: true };
  for (const k of ["accountId", "region", "id", "keepAlive"]) delete rule[k];
  assert.equal((await request("/rules", { target, rule }, "PUT")).status, 200);
  assert.equal(r.store.rule(target).keepAlive, null);
  assert.equal(r.store.rule(target).hold, "manual");
  assert.ok(r.calls.every((c) => !c.options.write));
  assert.ok(r.store.logs().some((x) => x.action === "keepalive-update"));
});

test("指定实例已找到后停止后续地域查询，其他地域 DNS 失败不阻塞接入", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  const queried = [];
  const original = r.gateway.instances.bind(r.gateway);
  r.gateway.regions = async () => [
    { regionId: "cn-hongkong" },
    { regionId: "cn-failed" },
    { regionId: "cn-empty" },
    ...Array.from({ length: 8 }, (_, n) => ({ regionId: "cn-later-" + n })),
  ];
  r.gateway.instances = async (account, region, ids) => {
    queried.push(region);
    if (region === "cn-hongkong") return original(account, region, ids);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (region === "cn-failed")
      throw new Error(
        "getaddrinfo ENOTFOUND ecs.cn-failed.aliyuncs.comPOST https://ecs.cn-failed.aliyuncs.com/?InstanceIds=i-web failed",
      );
    return [];
  };
  const { status, data } = await request("/connections/discover", {
    name: "真实查询场景",
    accessKeyId: "fixture-key",
    accessKeySecret: "fixture-secret",
    site: "china",
    instanceId: "i-web",
  });
  assert.equal(status, 200);
  assert.deepEqual(
    data.items.map((i) => i.id),
    ["i-web"],
  );
  assert.deepEqual(queried, ["cn-hongkong", "cn-failed", "cn-empty"]);
  assert.deepEqual(data.errors, [
    "cn-failed：阿里云接口域名暂时无法解析，请稍后重试",
  ]);
  assert.ok(!r.calls.some((call) => call.options.write));
});

test("指定 ID 逐台添加共用凭证，名称刷新后保留且不修改云端", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  const body = {
    accessKeyId: "multi-key",
    accessKeySecret: "multi-secret",
    site: "china",
    name: "单台名称",
    instanceId: "i-web",
  };
  const regionResult = await request("/connections/regions", {
    accessKeyId: body.accessKeyId,
    accessKeySecret: body.accessKeySecret,
    site: body.site,
  });
  assert.equal(regionResult.status, 200);
  assert.ok(regionResult.data.items.some((x) => x.regionId === "cn-hongkong"));
  assert.ok(!JSON.stringify(regionResult.data).includes("multi-secret"));
  const d = (await request("/connections/discover", body)).data;
  assert.equal(d.items.length, 1);
  const first = { id: "i-web", region: "cn-hongkong" },
    second = { id: "i-edge", region: "cn-hangzhou" };
  assert.equal(
    (
      await request("/connections/import", {
        token: d.token,
        targets: [first, second],
      })
    ).status,
    400,
  );
  const result = await request("/connections/import", {
    token: d.token,
    targets: [{ ...first, name: "香港主站" }],
  });
  assert.equal(result.status, 200);
  const accountId = result.data.accountId;
  const secondScan = (
    await request("/connections/discover", {
      ...body,
      instanceId: second.id,
      name: "杭州备用",
    })
  ).data;
  const secondImport = await request("/connections/import", {
    token: secondScan.token,
    targets: [second],
  });
  assert.equal(secondImport.data.accountId, accountId);
  await r.service.refresh({ accountId });
  assert.deepEqual(
    r.service
      .instances({ accountId })
      .items.map((i) => i.name)
      .sort(),
    ["杭州备用", "香港主站"].sort(),
  );
  assert.equal(r.service.instances({ accountId }).items.length, 2);
  const account = r.store.account(accountId);
  const renamed = await request(
    "/connections/" + accountId,
    {
      name: account.name,
      accessKeyId: body.accessKeyId,
      accessKeySecret: "",
      site: "china",
      region: "cn-hongkong",
      instance: { target: { ...first, accountId }, name: "主站新名称" },
    },
    "PUT",
  );
  assert.equal(renamed.status, 200);
  assert.equal(r.service.instance({ ...first, accountId }).name, "主站新名称");
  assert.equal(r.service.instance({ ...second, accountId }).name, "杭州备用");
  assert.ok(r.calls.every((c) => !c.options.write));
  const single = (
    await request("/connections/discover", { ...body, instanceId: "i-data" })
  ).data;
  assert.equal(single.items.length, 1);
  assert.equal(
    (
      await request("/connections/import", {
        token: single.token,
        targets: [{ id: "i-data", region: "cn-hongkong" }],
      })
    ).status,
    200,
  );
  assert.equal(
    r.service.instance({ accountId, id: "i-data", region: "cn-hongkong" }).name,
    "单台名称",
  );
  assert.equal(
    r.store.rule({ accountId, id: "i-data", region: "cn-hongkong" }).keepAlive,
    null,
  );
});
test("名称和 ECS ID 必填，拆分设置不覆盖保活及其他规则", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  for (const changes of [
    { name: "" },
    { instanceId: "" },
    { instanceId: "not-swas-or-ecs" },
  ]) {
    const res = await request("/connections/discover", {
      accessKeyId: "key",
      accessKeySecret: "secret",
      site: "china",
      name: "web",
      instanceId: "i-web",
      ...changes,
    });
    assert.equal(res.status, 400);
    assert.equal(r.calls.length, 0);
  }
  await r.service.refresh();
  r.store.saveRule(target, {
    keepAlive: false,
    hold: "manual",
    thresholdEnabled: true,
    thresholdPercent: 80,
  });
  const saved = await request(
    "/rules/schedule",
    {
      target,
      rule: {
        scheduleEnabled: true,
        scheduleStopEnabled: false,
        start: "08:00",
        stop: "08:00",
        timezone: "Asia/Shanghai",
        stoppedMode: "KeepCharging",
      },
    },
    "PUT",
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const rule = r.store.rule(target);
  assert.equal(rule.keepAlive, false);
  assert.equal(rule.hold, "manual");
  assert.equal(rule.thresholdPercent, 80);
  assert.equal(rule.scheduleStopEnabled, false);
  const traffic = await request(
    "/rules/traffic",
    {
      target,
      rule: {
        thresholdEnabled: true,
        thresholdPercent: 95,
        thresholdUnit: "percent",
        thresholdGiB: 180,
        thresholdAction: "stop",
        autoRecover: true,
        stoppedMode: "StopCharging",
      },
    },
    "PUT",
  );
  assert.equal(traffic.status, 200, JSON.stringify(traffic.data));
  assert.equal(r.store.rule(target).start, "08:00");
  assert.equal(r.store.rule(target).scheduleEnabled, true);
  assert.equal(
    (await request("/backup/export", { password: "unused" })).status,
    404,
  );
});

test("定时只开机不会在窗口外关机，下一次仍为开机", () => {
  const r = {
    ...defaultRule(target),
    keepAlive: false,
    scheduleEnabled: true,
    scheduleStopEnabled: false,
    start: "08:00",
    stop: "09:00",
  };
  const now = Date.parse("2026-10-14T16:00:00+08:00");
  assert.equal(decide({ status: "Running" }, r, {}, { now }).action, undefined);
  const next = nextSchedule(r, new Date(now));
  assert.equal(next.nextAction, "start");
  assert.equal(next.nextAt, "2026-10-15T00:00:00.000Z");
  assert.equal(
    decide(
      { status: "Stopped" },
      r,
      {},
      { now: Date.parse("2026-10-14T08:01:00+08:00") },
    ).action,
    "start",
  );
  assert.equal(
    decide(
      { status: "Stopped" },
      { ...r, hold: "manual" },
      {},
      { now: Date.parse("2026-10-14T08:01:00+08:00") },
    ).action,
    undefined,
  );
});
test("实例页合并刷新只执行当前筛选范围的规则，普通读取不执行", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  const web = { ...target, id: "i-web" };
  const outside = { ...target, region: "cn-hangzhou", id: "i-edge" };
  r.store.saveRule(target, { keepAlive: true });
  r.store.saveRule(web, { thresholdEnabled: true, thresholdPercent: 1 });
  r.store.saveRule(outside, { keepAlive: true });
  r.state.set(outside.id, "Stopped");
  await r.service.refresh();
  const read = await request("/instances");
  assert.equal(read.status, 200);
  assert.equal(r.store.list("job").length, 0);
  const response = await request("/refresh", {
    accountId: target.accountId,
    region: target.region,
    check: true,
  });
  assert.equal(response.status, 200);
  assert.equal(r.state.get(target.id), "Running");
  assert.equal(r.state.get(web.id), "Stopped");
  assert.equal(r.state.get(outside.id), "Stopped");
  assert.equal(r.store.rule(web).hold, "traffic");
  assert.equal(r.store.rule(outside).lastCheck, undefined);
  assert.deepEqual(
    response.data.items.map((i) => i.id).sort(),
    [target.id, web.id].sort(),
  );
});

test("移除全局保活设置后默认始终开启，实例单独关闭仍生效，日报默认为零点", async (t) => {
  const r = runtime(t),
    request = await http(t, r);
  r.store.saveSettings({ ...r.store.settings(), keepAliveDefault: false });
  assert.equal(r.store.settings().keepAliveDefault, true);
  assert.equal(r.store.settings().reportTime, "00:00");
  r.store.saveRule(target, { keepAlive: null });
  await r.service.refresh();
  assert.equal(r.service.instance(target).effectiveKeepAlive, true);
  r.store.saveRule(target, { keepAlive: false });
  assert.equal(r.service.instance(target).effectiveKeepAlive, false);
  const { keepAliveDefault: _, ...editable } = r.store.settings();
  const result = await request("/settings", editable, "PUT");
  assert.equal(result.status, 200);
  assert.equal(result.data.keepAliveDefault, true);
  assert.equal(r.store.rule(target).keepAlive, false);
});
