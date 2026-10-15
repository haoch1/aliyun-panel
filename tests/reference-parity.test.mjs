import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { fixture } from "./fixture.mjs";
import { defaultRule } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { notificationChoices } from "../shared/notification-preferences.ts";
import { billKey, billingCycle } from "../server/billing.mjs";
import { decide, schedule, usageOver, clockDue } from "../shared/policy.mjs";
import {
  cycleDetails,
  formatNotification,
  notificationExamples,
} from "../shared/notifications.ts";

const web = { accountId: "account-test", region: "cn-hongkong", id: "i-web" };
const data = { ...web, id: "i-data" };
const GiB = 1024 ** 3;
function runtime(t, at = "2026-10-15T00:55:00Z") {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const dir = mkdtempSync(join(tmpdir(), "aliyun-test-"));
  const r = fixture(dir);
  t.after(() => {
    r.store.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + "aliyun-test-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const settings = r.store.settings();
  settings.checkInterval = 3600;
  Object.assign(settings.notifications, {
    telegramToken: "fixture-token",
    telegramChatId: "fixture-chat",
    events: notificationChoices
      .map((v) => v.value)
      .filter((v) => v !== "daily" && v !== "cycle"),
  });
  r.store.saveSettings(settings);
  return r;
}

test("错过关机分钟且检测间隔为一小时，CDT/BSS 故障仍确认定时关机", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.store.saveRule(web, {
    keepAlive: true,
    scheduleEnabled: true,
    start: "08:00",
    stop: "09:00",
    thresholdEnabled: true,
  });
  await r.engine.cycle(true);
  assert.equal(r.store.list("job").length, 0);
  t.mock.timers.setTime(Date.parse("2026-10-15T01:02:00Z"));
  r.gateway.usage = async () => {
    throw new Error("CDT timeout");
  };
  r.gateway.balance = async () => {
    throw new Error("BSS AccessDenied");
  };
  await r.engine.billing.refresh({ force: true });
  await r.engine.cycle();
  const job = r.store.list("job").find((j) => j.instanceId === web.id);
  assert.equal(job.source, "schedule");
  assert.equal(job.action, "stop");
  await r.jobs.run(job);
  assert.equal(r.store.get("job", job.id).status, "success");
  assert.equal(r.state.get(web.id), "Stopped");
  assert.equal(
    r.calls.find((c) => c.action === "StopInstance").params.stoppedMode,
    "KeepCharging",
  );
});

test("启动服务时补执行当前运行时段，成功后重启不重放已完成的定时开机", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.store.saveRule(data, {
    keepAlive: false,
    scheduleEnabled: true,
    start: "08:00",
    stop: "23:00",
  });
  await r.engine.cycle(true);
  const job = r.store.list("job").find((j) => j.instanceId === data.id);
  assert.equal(job.source, "schedule");
  await r.jobs.run(job);
  assert.equal(r.store.get("job", job.id).status, "success");
  r.state.set(data.id, "Stopped");
  const restart = new Engine(r.store, r.gateway, r.service, r.jobs, r.notify);
  await restart.cycle(true);
  assert.equal(
    r.store.list("job").filter((j) => j.instanceId === data.id).length,
    1,
  );
  assert.equal(r.calls.filter((c) => c.action === "StartInstance").length, 1);
});

test("跨午夜开机周期不重复，定时来源优先识别，手动保护不阻止必要的关机", () => {
  const rule = {
    ...defaultRule(web),
    keepAlive: true,
    scheduleEnabled: true,
    start: "22:00",
    stop: "06:00",
  };
  const before = schedule(rule, new Date("2026-10-14T15:30:00Z"));
  const after = schedule(rule, new Date("2026-10-14T17:30:00Z"));
  assert.equal(before.key, after.key);
  assert.equal(
    decide(
      { status: "Stopped" },
      rule,
      {},
      { now: Date.parse("2026-10-14T15:30:00Z") },
    ).source,
    "schedule",
  );
  assert.equal(
    decide(
      { status: "Stopped" },
      { ...rule, keepAlive: false, lastSchedule: before.key },
      {},
      { now: Date.parse("2026-10-14T17:30:00Z") },
    ).action,
    undefined,
  );
  assert.equal(
    decide(
      { status: "Running" },
      { ...rule, hold: "manual" },
      {},
      { now: Date.parse("2026-10-15T01:00:00Z") },
    ).action,
    "stop",
  );
  assert.equal(
    decide(
      { status: "Stopped" },
      { ...rule, hold: "manual" },
      {},
      { now: Date.parse("2026-10-14T15:30:00Z") },
    ).action,
    undefined,
  );
});

test("月初不沿用上月短缓存，也不允许上月快照解除流量保护", async (t) => {
  const r = runtime(t, "2026-10-31T15:59:55Z");
  const rows = await r.gateway.usage(web.accountId, web.region, [web.id]);
  t.mock.timers.setTime(Date.parse("2026-10-31T16:00:05Z"));
  await r.gateway.usage(web.accountId, web.region, [web.id]);
  assert.equal(
    r.calls.filter((c) => c.action === "ListCdtInternetTraffic").length,
    2,
  );
  const u = { used: 0, total: 200 * GiB, quota: "finite", at: rows[0].at };
  assert.equal(
    usageOver({ ...defaultRule(web), thresholdEnabled: true }, u).valid,
    false,
  );
});

test("同轮不同地域只读取一次 CDT，其他实例也得到最新流量", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.gateway.invalidate();
  r.calls.length = 0;
  const original = r.gateway.usage.bind(r.gateway);
  r.gateway.usage = async (...args) => {
    const result = await original(...args);
    r.gateway.cache.clear(); // Simulate short cache expiry between region requests.
    return result;
  };
  await r.service.statusCycle();
  assert.equal(
    r.calls.filter((c) => c.action === "ListCdtInternetTraffic").length,
    1,
  );
  assert.ok(
    r.service.instances().items.every((i) => i.usage.at === Date.now()),
  );
});

test("持续超限去重，查询失败不假恢复，恢复后再次超限重新告警", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.store.saveRule(web, {
    thresholdEnabled: true,
    thresholdAction: "notify",
    thresholdPercent: 90,
  });
  let used = 181 * GiB,
    failed = false;
  r.gateway.usage = async (a, region, ids) => {
    if (failed) throw new Error("CDT timeout");
    return ids.map((instanceId) => ({
      instanceId,
      trafficUsed: used,
      trafficPackageTotal: 200 * GiB,
      at: Date.now(),
    }));
  };
  await r.engine.cycle(true);
  await r.engine.cycle(true);
  failed = true;
  await r.engine.cycle(true);
  assert.equal(
    r.store.list("outbox").filter((x) => x.title === "流量保护恢复").length,
    0,
  );
  failed = false;
  used = 100 * GiB;
  await r.engine.cycle(true);
  assert.equal(
    r.store.list("outbox").filter((x) => x.title === "流量保护恢复").length,
    1,
  );
  used = 190 * GiB;
  const restart = new Engine(r.store, r.gateway, r.service, r.jobs, r.notify);
  await restart.cycle(true);
  assert.equal(
    r.store.list("outbox").filter((x) => x.title === "流量阈值告警").length,
    2,
  );
  assert.equal(
    r.calls.some((c) => /StartInstance|StopInstance/.test(c.action)),
    false,
  );
});

test("流量关机核实后安全恢复，恢复开机依然受手动保护与定时窗口限制", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.store.saveRule(web, {
    keepAlive: true,
    thresholdEnabled: true,
    autoRecover: true,
  });
  let used = 181 * GiB;
  r.gateway.usage = async (a, region, ids) =>
    ids.map((instanceId) => ({
      instanceId,
      trafficUsed: used,
      trafficPackageTotal: 200 * GiB,
      at: Date.now(),
    }));
  await r.engine.cycle(true);
  const stop = r.store.list("job").find((j) => j.instanceId === web.id);
  await r.jobs.run(stop);
  assert.equal(r.store.get("job", stop.id).status, "success");
  assert.equal(r.store.rule(web).hold, "traffic");
  used = 1 * GiB;
  r.store.saveRule(web, {
    scheduleEnabled: true,
    start: "10:00",
    stop: "23:00",
  });
  await r.engine.cycle(true);
  assert.equal(r.store.rule(web).hold, undefined);
  assert.equal(
    r.store.list("job").filter((j) => j.action === "start").length,
    0,
  );
  t.mock.timers.setTime(Date.parse("2026-10-15T02:05:00Z"));
  await r.engine.cycle();
  const start = r.store.list("job").find((j) => j.action === "start");
  assert.equal(start.source, "schedule");
  await r.jobs.run(start);
  assert.equal(r.state.get(web.id), "Running");
  assert.equal(r.store.get("job", start.id).status, "success");
});

test("普通定时停机保留资源且不被保活提前拉起，运行时段意外停止会记录保活开机", async (t) => {
  const r = runtime(t, "2026-10-14T23:00:00Z"); // 北京时间 07:00。
  await r.service.refresh();
  r.store.saveRule(web, {
    keepAlive: true,
    scheduleEnabled: true,
    start: "08:00",
    stop: "23:00",
  });
  await r.engine.cycle(true);
  const stop = r.store.list("job").find((j) => j.instanceId === web.id);
  assert.equal(stop.source, "schedule");
  await r.jobs.run(stop);
  assert.equal(r.state.get(web.id), "Stopped");
  assert.equal(r.store.rule(web).keepAlive, true);
  assert.equal(
    r.calls.find((c) => c.action === "StopInstance").params.stoppedMode,
    "KeepCharging",
  );
  t.mock.timers.setTime(Date.parse("2026-10-14T23:05:00Z"));
  await r.engine.cycle(true);
  assert.equal(r.calls.filter((c) => c.action === "StartInstance").length, 0);
  const idle = r.store.logs().find((log) => log.action === "monitor-cycle");
  assert.match(
    idle.context.resources.find((i) => i.id === web.id).reason,
    /定时停机/,
  );

  t.mock.timers.setTime(Date.parse("2026-10-15T00:00:00Z"));
  await r.engine.cycle();
  const start = r.store
    .list("job")
    .find((j) => j.instanceId === web.id && j.action === "start");
  assert.equal(start.source, "schedule");
  await r.jobs.run(start);
  assert.equal(r.state.get(web.id), "Running");

  t.mock.timers.setTime(Date.parse("2026-10-15T01:00:00Z"));
  r.state.set(web.id, "Stopped");
  await r.engine.cycle(true);
  const keepalive = r.store
    .list("job")
    .find((j) => j.instanceId === web.id && j.source === "keepalive");
  assert.equal(
    r.store.logs().find((log) => log.id === keepalive.auditId).context.phase,
    "queued",
  );
  await r.jobs.run(keepalive);
  const log = r.store.logs().find((entry) => entry.id === keepalive.auditId);
  assert.equal(log.action, "keepalive-start");
  assert.equal(log.context.before, "Stopped");
  assert.equal(log.context.actual, "Running");
  assert.equal(log.context.phase, "success");
  assert.equal(log.context.requestId, "fixture-start");
});

for (const [mode, expected] of [
  [
    "events",
    ["成功动作", "流量告警", "检测错误", "检测恢复", "日报", "TG 通知测试"],
  ],
  ["errors", ["检测错误", "日报", "TG 通知测试"]],
  [
    "always",
    [
      "检测完成",
      "成功动作",
      "流量告警",
      "检测错误",
      "检测恢复",
      "日报",
      "TG 通知测试",
    ],
  ],
  ["off", ["TG 通知测试"]],
]) {
  test(`通知 ${mode} 模式按实际级别筛选，日报和手动测试遵循各自规则`, async (t) => {
    const r = runtime(t);
    const settings = r.store.settings();
    delete settings.notifications.events;
    settings.notifications.mode = mode;
    r.store.saveSettings(settings);
    await r.service.refresh();
    await r.engine.cycle(true);
    for (const [key, title, level, kind] of [
      ["action", "成功动作", "info"],
      ["threshold", "流量告警", "warning"],
      ["error", "检测错误", "error"],
      ["recovery", "检测恢复", "info"],
      ["report", "日报", "info", "report"],
    ]) {
      r.notify.event(key, title, "测试内容", { level, kind });
      r.notify.event(key, title, "相同事件不重复", { level, kind });
    }
    r.notify.test();
    assert.deepEqual(
      r.store
        .list("outbox")
        .map((item) => item.title)
        .sort(),
      [...expected].sort(),
    );
    for (let attempt = 0; attempt < 3; attempt++) await r.notify.tick();
    assert.ok(r.store.list("outbox").every((item) => item.status === "sent"));
  });
}

test("一个 ECS ID 无效不阻断同组保活；权限错误不触发拆分风暴", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.store.saveRule(data, { keepAlive: true });
  const original = r.gateway.rpc;
  r.gateway.rpc = async (a, region, action, params, options) => {
    if (
      action === "DescribeInstances" &&
      JSON.parse(params.instanceIds || "[]").includes(web.id)
    )
      throw Object.assign(new Error("InvalidInstanceId.NotFound"), {
        code: "InvalidInstanceId.NotFound",
      });
    return original(a, region, action, params, options);
  };
  await r.engine.cycle(true);
  assert.equal(r.service.instance(web).statusAt, 0);
  assert.ok(r.service.instance(web).statusError.includes("InvalidInstanceId"));
  assert.ok(r.service.instance(data).statusAt);
  assert.ok(
    r.store
      .list("job")
      .some((j) => j.instanceId === data.id && j.action === "start"),
  );
  let attempts = 0;
  r.gateway.rpc = async () => {
    attempts++;
    throw new Error("AccessDenied");
  };
  const statuses = await r.gateway.statuses(web.accountId, web.region, [
    web.id,
    data.id,
  ]);
  assert.equal(attempts, 1);
  assert.ok(statuses.every((x) => x.error === "AccessDenied"));
});

test("云端权限拒绝使用持久化冷却，修复后恢复保活且不覆盖人工停机", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.store.saveRule(data, { keepAlive: true });
  const control = r.gateway.control.bind(r.gateway);
  r.gateway.control = async (...args) => {
    if (args[0].id === data.id)
      throw Object.assign(new Error("RAM policy denied"), {
        code: "Forbidden.RAM",
      });
    return control(...args);
  };
  await r.engine.cycle(true);
  const failed = r.store.list("job").find((j) => j.instanceId === data.id);
  await r.jobs.run(failed);
  assert.equal(r.store.get("job", failed.id).status, "failed");
  assert.equal(r.store.rule(data).paused, false);
  assert.equal(r.store.rule(data).keepAlive, true);
  assert.ok(r.jobs.controlBackoff(data));
  const restart = new Engine(r.store, r.gateway, r.service, r.jobs, r.notify);
  r.store.saveRule(web, { thresholdEnabled: true, thresholdPercent: 40 });
  await restart.cycle(true);
  assert.equal(
    r.store.list("job").filter((j) => j.instanceId === data.id).length,
    1,
  );
  const healthy = r.store.list("job").find((j) => j.instanceId === web.id);
  await r.jobs.run(healthy);
  assert.equal(r.state.get(web.id), "Stopped");
  assert.equal(r.store.get("job", healthy.id).status, "success");
  r.store.saveRule(data, { hold: "manual" });
  t.mock.timers.setTime(Date.now() + 301000);
  r.gateway.control = control;
  await restart.cycle(true);
  assert.equal(
    r.store.list("job").filter((j) => j.instanceId === data.id).length,
    1,
  );
  r.store.saveRule(data, { hold: undefined });
  await restart.cycle(true);
  const retried = r.store
    .list("job")
    .find((j) => j.instanceId === data.id && j.status === "queued");
  await r.jobs.run(retried);
  assert.equal(r.store.get("job", retried.id).status, "success");
  assert.equal(r.state.get(data.id), "Running");
  assert.equal(r.jobs.controlBackoff(data), undefined);
});

test("账单与余额失败独立保留缓存，15 分钟重试，TG 使用实例名称", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const settings = r.store.settings();
  settings.billingInterval = 86400;
  r.store.saveSettings(settings);
  await r.engine.billing.refresh({ force: true });
  const prior = r.store.get("billing", billKey(web.accountId, billingCycle()));
  let reads = 0;
  const balance = r.gateway.balance.bind(r.gateway);
  r.gateway.balance = async () => {
    reads++;
    throw new Error("balance timeout");
  };
  r.gateway.billRows = async () => [
    { instanceID: web.id, pretaxAmount: 55, currency: "CNY" },
  ];
  await r.engine.billing.refresh({ force: true });
  const failed = r.store.get("billing", billKey(web.accountId, billingCycle()));
  assert.equal(failed.balanceAt, prior.balanceAt);
  assert.equal(failed.items[0].pretaxAmount, 55);
  assert.ok(failed.balanceError);
  await r.engine.billing.refresh();
  assert.equal(reads, 1);
  t.mock.timers.setTime(Date.now() + 900000);
  await r.engine.billing.refresh();
  assert.equal(reads, 2);
  const warning = r.store
    .list("outbox")
    .find((i) => i.title === "账单查询异常");
  assert.ok(warning.instance.name);
  assert.ok(!formatNotification(warning).includes("开发账号"));
  r.gateway.balance = balance;
  await r.engine.billing.refresh({ force: true });
  assert.ok(r.store.list("outbox").some((i) => i.title === "账单查询恢复"));
});

test("账单等待跨过午夜，日报使用完成查询后的日期并补偿十分钟且持久去重", async (t) => {
  const r = runtime(t, "2026-10-14T15:59:50Z");
  await r.service.refresh();
  const settings = r.store.settings();
  settings.dailyReport = true;
  settings.notifications.events.push("daily");
  r.store.saveSettings(settings);
  r.engine.billing.refresh = async () => {
    t.mock.timers.setTime(Date.now() + 20000);
  };
  await r.engine.reports();
  await r.engine.reports();
  const report = r.store.list("outbox").filter((i) => i.kind === "report");
  assert.equal(report.length, 1);
  assert.equal(report[0].title, "Aliyun 实例日报 2026-10-15");
  t.mock.timers.setTime(Date.parse("2026-10-15T16:11:00Z"));
  await r.engine.reports();
  assert.equal(
    r.store.list("outbox").filter((i) => i.kind === "report").length,
    1,
  );
  assert.equal(
    clockDue(new Date("2026-03-08T07:05:00Z"), "America/New_York", "02:30"),
    true,
  );
});

test("余额金额缺失不覆盖有效缓存，已到点的日报不因账单慢查询漏发", async (t) => {
  const r = runtime(t, "2026-10-14T16:09:00Z");
  await r.service.refresh();
  await r.engine.billing.refresh({ force: true });
  const original = r.gateway.rpc;
  r.gateway.rpc = async (a, region, action, params, options) =>
    action === "QueryAccountBalance"
      ? { data: { currency: "CNY" } }
      : original(a, region, action, params, options);
  await r.engine.billing.refresh({ force: true });
  const cached = r.store.get("billing", billKey(web.accountId, billingCycle()));
  assert.equal(cached.balance.availableAmount, "100.00");
  assert.ok(cached.balanceError.includes("有效金额"));
  const settings = r.store.settings();
  settings.dailyReport = true;
  settings.notifications.events.push("daily");
  r.store.saveSettings(settings);
  r.engine.billing.refresh = async () => {
    t.mock.timers.setTime(Date.now() + 20 * 60000);
  };
  await r.engine.reports();
  assert.ok(
    r.store
      .list("outbox")
      .some((x) => x.kind === "report" && x.title.endsWith("2026-10-15")),
  );
});

test("TG 429 尊重 retry_after，全通道等待避免同轮继续触发限流", async (t) => {
  const r = runtime(t);
  let calls = 0;
  const server = createServer((req, res) => {
    // Consume the complete POST body before responding. Closing an unread
    // request can produce ECONNRESET instead of a 429 under parallel test load.
    req.on("end", () => {
      calls++;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 120 },
        }),
      );
    });
    req.resume();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const settings = r.store.settings();
  settings.notifications.apiBase = "http://127.0.0.1:" + server.address().port;
  r.store.saveSettings(settings);
  r.notify.sendOverride = undefined;
  r.notify.event("one", "保活开机", "已确认实例运行");
  r.notify.event("two", "定时关机", "已确认实例停止");
  await r.notify.tick();
  const out = r.store.list("outbox");
  assert.equal(
    calls,
    1,
    JSON.stringify(
      out.map((i) => ({
        id: i.id,
        attempts: i.attempts,
        error: i.error,
        nextAt: i.nextAt,
      })),
    ),
  );
  assert.equal(
    out.find((i) => i.id === "one:telegram").nextAt,
    Date.now() + 120000,
  );
  assert.equal(out.find((i) => i.id === "two:telegram").attempts, 0);
  await r.notify.tick();
  assert.equal(calls, 1);
  t.mock.timers.setTime(Date.now() + 120000);
  r.notify.sendOverride = async () => {};
  await r.notify.tick();
  assert.ok(r.store.list("outbox").every((i) => i.status === "sent"));
});

test("每轮 TG 简要展示状态流量费用，计划动作不伪装成功，内容有界且预览一致", () => {
  const items = Array.from({ length: 20 }, (_, n) => ({
    name: "实例 <" + n + ">",
    region: "cn-hongkong",
    status: "Running",
    usage: { used: 181 * GiB, total: 200 * GiB },
    billing: { amount: 24, currency: "CNY" },
    decision: n === 0 ? "stop" : "none",
    source: "traffic",
  }));
  const message = cycleDetails(items);
  assert.ok(message.includes("181.0 / 200.0 GB"));
  assert.ok(message.includes("24.00 CNY"));
  assert.ok(message.includes("等待执行"));
  assert.ok(!message.includes("已确认"));
  assert.ok(!message.includes("实例 <5>"));
  assert.ok(message.includes("其余 15 台"));
  const html = formatNotification(
    { title: "检测完成", kind: "cycle", message },
    true,
  );
  assert.ok(html.includes("&lt;0&gt;"));
  assert.ok(html.length < 4096);
  assert.ok(notificationExamples.some((x) => x.id === "traffic-recovery"));
  assert.ok(
    formatNotification(
      notificationExamples.find((x) => x.id === "traffic").item,
    ).includes("已用"),
  );
});
