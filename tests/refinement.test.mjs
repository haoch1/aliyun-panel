import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fixture } from "./fixture.mjs";
import {
  formatNotification,
  notificationExamples,
  dailySummary,
} from "../shared/notifications.ts";
import { groupDataTimes, formatDate } from "../shared/presentation.ts";
import {
  resourceLogSummary,
  monitorLogTitle,
  eventLogSummary,
} from "../shared/log-presentation.ts";
import { createApp } from "../server/app.mjs";
import { createServer } from "node:http";
import { telegramText } from "../server/notify.mjs";
function runtime(t) {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-refinement-")),
    r = fixture(dir);
  t.after(() => {
    r.store.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + "aliyun-refinement-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  return r;
}
test("日志保存每轮状态、套餐用量和规则原因，提交与核实状态可以追溯", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const target = {
    accountId: r.account.id,
    region: "cn-hongkong",
    id: "i-data",
  };
  r.store.saveRule(target, { keepAlive: true });
  await r.engine.cycle(true);
  const cycle = r.store.logs().find((x) => x.action === "monitor-cycle");
  const item = cycle.context.resources.find((x) => x.id === target.id);
  assert.equal(item.status, "Stopped");
  assert.equal(item.decision, "start");
  assert.equal(item.source, "keepalive");
  assert.ok(item.statusAt > 0 && item.usage.at > 0);
  assert.ok(item.reason.includes("保活"));
  const job = r.store.list("job").find((x) => x.instanceId === target.id);
  await r.jobs.run(job);
  const log = r.store.logs().find((x) => x.id === job.auditId);
  assert.equal(log.context.before, "Stopped");
  assert.equal(log.context.actual, "Running");
  assert.equal(log.context.expected, "Running");
  assert.equal(log.context.phase, "success");
  assert.ok(log.context.completedAt >= Date.parse(log.at));
});
test("详细日志保留上下文，并隐藏凭证与通知秘密", (t) => {
  const r = runtime(t),
    s = r.store.settings();
  s.notifications.telegramToken = "private-telegram-token";
  r.store.saveSettings(s);
  const id = r.store.audit({
    action: "probe",
    detail: "fixture-secret private-telegram-token fixture-key",
    context: {
      accessKeySecret: "new-not-saved-secret",
      password: "private-password",
      reason: "fixture-secret",
      resources: [{ error: "private-telegram-token" }],
    },
  });
  const encoded = JSON.stringify(r.store.logs());
  for (const secret of [
    "fixture-secret",
    "private-telegram-token",
    "fixture-key",
    "new-not-saved-secret",
    "private-password",
  ])
    assert.ok(!encoded.includes(secret));
  assert.equal(
    r.store.logs().find((x) => x.id === id).context.reason,
    "[已隐藏]",
  );
});
test("账单和余额独立记录成功时间，余额失败只通知一次，恢复后通知恢复", async (t) => {
  const r = runtime(t),
    s = r.store.settings();
  s.notifications.events.push("billing-recovery");
  Object.assign(s.notifications, {
    telegramToken: "fake-token",
    telegramChatId: "fake-chat",
  });
  r.store.saveSettings(s);
  await r.service.refresh();
  await r.engine.billing.refresh({ force: true });
  const first = r.engine.billing.view().items[0],
    balance = r.gateway.balance.bind(r.gateway);
  r.gateway.balance = async () => {
    throw new Error("余额查询超时");
  };
  await r.engine.billing.refresh({ force: true });
  await r.engine.billing.refresh({ force: true });
  const failed = r.engine.billing.view().items[0];
  assert.equal(failed.balanceAt, first.balanceAt);
  assert.deepEqual(failed.balance, first.balance);
  assert.ok(failed.at >= first.at);
  assert.ok(failed.checkedAt >= first.checkedAt);
  // The check timestamp is recorded before the successful bill timestamp.
  assert.ok(failed.checkedAt <= failed.at);
  assert.equal(
    r.store.list("outbox").filter((x) => x.title === "账单查询异常").length,
    1,
  );
  const log = r.store
    .logs()
    .find((x) => x.action === "billing-refresh" && x.status === "failed");
  assert.equal(log.context.balanceStatus, "failed");
  assert.equal(log.context.billStatus, "success");
  assert.equal(log.context.retainedCache, true);
  r.gateway.balance = balance;
  await r.engine.billing.refresh({ force: true });
  assert.equal(
    r.store.list("outbox").filter((x) => x.title === "账单查询恢复").length,
    1,
  );
});
test("TG 发送失败与重试有日志，最终成功清除旧错误且记录实际次数", async (t) => {
  const r = runtime(t),
    s = r.store.settings();
  Object.assign(s.notifications, {
    telegramToken: "fake-token",
    telegramChatId: "fake-chat",
  });
  r.store.saveSettings(s);
  r.notify.sendOverride = async () => {
    throw new Error("temporary fake-token");
  };
  r.notify.test();
  const original = r.store.list("outbox")[0];
  const originalMessage = telegramText(original);
  await r.notify.tick();
  let item = r.store.list("outbox")[0];
  assert.equal(item.attempts, 1);
  assert.equal(item.status, "queued");
  assert.ok(!item.error.includes("fake-token"));
  assert.equal(
    r.store.logs().find((x) => x.action === "notification-retry").context
      .attempts,
    1,
  );
  r.store.put("outbox", item.id, { ...item, nextAt: 0 });
  r.notify.sendOverride = async () => {};
  await r.notify.tick();
  item = r.store.list("outbox")[0];
  assert.equal(item.attempts, 2);
  assert.equal(item.status, "sent");
  assert.equal(item.error, undefined);
  assert.equal(item.at, original.at);
  assert.equal(telegramText(item), originalMessage);
  assert.equal(
    r.store.logs().find((x) => x.action === "notification-sent").context
      .attempts,
    2,
  );
});

test("TG 连接超时保留原消息等待重试，日志明确通知来源，重试成功后只保留一条投递记录", async (t) => {
  const r = runtime(t),
    s = r.store.settings();
  Object.assign(s.notifications, {
    telegramToken: "fake-token",
    telegramChatId: "fake-chat",
  });
  r.store.saveSettings(s);
  r.notify.sendOverride = async () => {
    throw Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      cause: new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    });
  };
  r.notify.test();
  const before = Date.now();
  await r.notify.tick();
  const item = r.store.list("outbox")[0];
  assert.equal(item.status, "queued");
  assert.equal(item.error, "Telegram 接口连接超时，请稍后重试");
  assert.ok(item.nextAt >= before + 60000);
  assert.match(
    r.store.logs().find((x) => x.action === "notification-retry").detail,
    /Telegram 接口连接超时/,
  );
  r.store.put("outbox", item.id, { ...item, nextAt: 0 });
  r.notify.sendOverride = async () => {};
  await r.notify.tick();
  const delivered = r.store.list("outbox");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, item.id);
  assert.equal(delivered[0].status, "sent");
  assert.equal(delivered[0].attempts, 2);
  assert.equal(delivered[0].error, undefined);
});
test("旧代理设置被剔除，通知示例使用实际 TG 模板且日报不会铺满字段", (t) => {
  const r = runtime(t),
    s = r.store.settings();
  s.notifications.proxyUrl = "socks5://obsolete";
  r.store.saveSettings(s);
  assert.equal(r.store.settings().notifications.proxyUrl, undefined);
  assert.equal(
    r.store.publicSettings().notifications.proxyConfigured,
    undefined,
  );
  for (const example of notificationExamples) {
    const plain = formatNotification(example.item),
      html = telegramText(example.item)
        .replace(/<\/?(?:b|blockquote)>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
    assert.equal(plain, html);
    if (!["report", "cycle"].includes(example.item.kind))
      assert.ok(plain.split("\n").filter(Boolean).length <= 6);
  }
  const items = Array.from({ length: 10 }, (_, i) => ({
    name: "实例 " + i,
    status: "Running",
    usage: { used: 1024 ** 3 },
    billing: { amount: 1, currency: "USD" },
  }));
  const summary = dailySummary(
    items,
    Array.from({ length: 5 }, (_, i) => ({
      accountName: "账号 " + i,
      balance: { availableAmount: i, currency: "USD" },
    })),
  );
  assert.ok(!summary.includes("实例 5"));
  assert.ok(summary.includes("其余 5 台"));
  assert.ok(!summary.includes("账号 "));
  assert.ok(!summary.includes("账户"));
});
test("日报只按实例展示，不输出账号名称或分组，共享流量取同池最新快照且不累加", () => {
  const GiB = 1024 ** 3;
  const instance = (name, accountId, region, used, at = 100) => ({
    name,
    accountId,
    accountName: accountId,
    region,
    status: "Running",
    usage: { used: used * GiB, total: 200 * GiB, at },
    billing: { amount: 1, currency: "USD" },
  });
  const summary = dailySummary(
    [
      instance("香港 Web", "账户 A", "cn-hongkong", 64.8),
      instance("备份服务器", "账户 A", "ap-southeast-1", 60, 90),
      instance("杭州 Web", "账户 A", "cn-hangzhou", 8),
      instance("东京 Web", "账户 B", "ap-northeast-1", 64.8),
    ],
    [],
  );
  assert.equal((summary.match(/共享流量 64.8/g) || []).length, 3);
  assert.equal((summary.match(/共享流量 8.0/g) || []).length, 1);
  assert.ok(!summary.includes("60.0"));
  assert.ok(!summary.includes("124.8"));
  assert.match(summary, /香港 Web · 运行\n共享流量/);
  assert.match(summary, /费用 1.00 USD/);
  assert.ok(!summary.includes("账户"));
  assert.ok(!summary.includes("（CDT）"));
});
test("日报关闭账单后仍显示共享流量，缺失不当零，缓存不当新数据", () => {
  const summary = dailySummary(
    [
      {
        name: "未知",
        accountId: "A",
        accountName: "账户 A",
        region: "cn-hongkong",
        status: "Stopped",
        usage: { used: null, total: null },
      },
      {
        name: "缓存",
        accountId: "A",
        accountName: "账户 A",
        region: "cn-hangzhou",
        status: "Running",
        usage: { used: 0, total: 20 * 1024 ** 3, error: "timeout" },
        billing: { amount: 1, currency: "CNY" },
      },
    ],
    [
      {
        accountId: "A",
        accountName: "账户 A",
        balance: { availableAmount: 100, currency: "CNY" },
      },
    ],
    false,
  );
  assert.match(summary, /共享流量 待同步/);
  assert.match(summary, /共享流量 0.0 \/ 20.0 GB（缓存）/);
  assert.ok(!summary.includes("余额"));
  assert.ok(!summary.includes("CNY"));
});
test("日志分列保留状态流量费用与执行阶段，待提交不能显示为成功，缺失流量不显示零", () => {
  const record = {
    status: "Stopped",
    keepAlive: true,
    usage: { used: null, total: null },
    thresholdEnabled: true,
    threshold: "90%",
    thresholdAction: "stop",
    decision: "start",
    source: "keepalive",
    execution: "queued",
    reason: "实例意外停止",
    billing: { amount: 4.5, currency: "USD", stale: true },
  };
  const summary = resourceLogSummary(record);
  assert.equal(summary.status, "已停止");
  assert.equal(summary.traffic, "待同步");
  assert.equal(summary.keepAlive, "开启");
  assert.equal(summary.cost, "4.50 USD（缓存）");
  assert.match(summary.action, /保活开机 · 等待提交/);
  assert.ok(!summary.action.includes("成功"));
  assert.equal(summary.reason, "实例意外停止");
  assert.match(monitorLogTitle([record]), /动作 1/);
  const cached = resourceLogSummary({
    status: "Running",
    keepAlive: false,
    usage: { used: 0, total: 200 * 1024 ** 3, error: "查询超时" },
    billing: { amount: 0, currency: "CNY" },
  });
  assert.equal(cached.traffic, "0.00 / 200.00 GB（缓存）");
  assert.equal(cached.cost, "0.00 CNY");
  assert.equal(cached.error, "查询超时");
  assert.equal(cached.keepAlive, "关闭");
  const missing = resourceLogSummary({ status: "Unknown" });
  assert.equal(missing.traffic, "待同步");
  assert.equal(missing.cost, "待同步");
  assert.equal(
    monitorLogTitle([{ status: "Running", decision: "none" }]),
    "检测完成 · 1 台",
  );
  assert.match(
    eventLogSummary({
      before: "Stopped",
      actual: "Running",
      phase: "success",
      requestId: "request-fixture",
    }),
    /已停止 → 运行中.*成功.*request-fixture/,
  );
});
test("手动立即检测会等待当前检测并执行新一轮，不返回空完成", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const real = r.service.statusCycle.bind(r.service);
  let release,
    count = 0;
  r.service.statusCycle = async () => {
    count++;
    if (count === 1) await new Promise((resolve) => (release = resolve));
    return real();
  };
  const running = r.engine.cycle(true);
  const manual = r.engine.cycle(true);
  assert.equal(count, 1);
  release();
  await Promise.all([running, manual]);
  assert.equal(count, 2);
  assert.equal(
    r.store.logs().filter((x) => x.action === "monitor-cycle").length,
    2,
  );
});
test("相同秒的数据时间合并来源，不同时间保留，统一北京时间", () => {
  const at = Date.parse("2026-10-14T11:00:00Z");
  const groups = groupDataTimes([
    { label: "刷新", value: at },
    { label: "检测", value: at + 500 },
    { label: "余额", value: at + 1000 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].labels, ["刷新", "检测"]);
  assert.match(groups[0].text, /19:00:00/);
  assert.match(groups[1].text, /19:00:01/);
  assert.equal(formatDate("invalid"), "尚未更新");
  assert.notEqual(formatDate(0), "尚未更新");
});

test("TG 引用块、地域标识与北京时间固定，普通动作不堆叠流量", () => {
  const sample = {
    title: "保活开机",
    at: "2026-10-14T11:00:00Z",
    instance: {
      name: "<Web>&<img src=x>",
      region: "cn-hongkong",
      usage: { used: 210 * 1024 ** 3, total: 200 * 1024 ** 3 },
    },
    message: "已确认实例运行",
  };
  const simple = formatNotification(sample, true);
  assert.match(simple, /^<b>🟢 保活开机<\/b>/);
  assert.match(simple, /<blockquote><b>🇭🇰 &lt;Web&gt;&amp;&lt;img src=x&gt;/);
  assert.ok(!simple.includes("<img"));
  assert.ok(!simple.includes("GB"));
  assert.ok(simple.endsWith("🕒 2026.10.14 - 19:00:00"));
  const flow = formatNotification({ ...sample, title: "流量关机" }, true);
  assert.match(flow, /<b>105.0%<\/b>/);
  assert.match(flow, /剩余 0.0 GB/);
  assert.equal((flow.match(/🕒/g) || []).length, 1);
  assert.ok(
    !formatNotification({
      ...sample,
      instance: { name: "新地域", region: "future-1" },
      at: "invalid",
    }).includes("undefined"),
  );
});
