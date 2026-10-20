import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { fixture } from "./fixture.mjs";
import { createApp } from "../server/app.mjs";
import {
  defaultNotificationTypes,
  notificationChoices,
  notificationSelection,
  notificationType,
  wantsNotification,
} from "../shared/notification-preferences.ts";
import {
  formatNotification,
  notificationIcon,
  notificationExamples,
} from "../shared/notifications.ts";

test("通知使用统一彩色语义图标，异常优先于动作和汇总", () => {
  const icons = {
    keepalive: "🟢",
    threshold: "🟠",
    traffic: "🟢",
    "traffic-recovery": "🟢",
    schedule: "🟢",
    manual: "🟢",
    "operation-error": "🔴",
    status: "🟠",
    error: "🔴",
    recovery: "🟢",
    billing: "🔴",
    "billing-recovery": "🟢",
    cycle: "🟢",
    daily: "🟢",
    test: "🟢",
  };
  for (const example of notificationExamples) {
    const expected = icons[example.id];
    assert.ok(expected, example.id);
    assert.ok(["🟢", "🟠", "🔴"].includes(notificationIcon(example.item)));
    assert.equal(notificationIcon(example.item), expected, example.id);
    assert.ok(formatNotification(example.item).startsWith(expected + " "));
    assert.ok(
      formatNotification(example.item, true).startsWith("<b>" + expected + " "),
    );
  }
  for (const title of ["定时关机", "手动关机", "保活开机", "检测恢复"]) {
    assert.equal(notificationIcon({ title, level: "error" }), "🔴");
  }
  assert.equal(
    notificationIcon({ title: "检测完成", kind: "cycle", level: "error" }),
    "🔴",
  );
  assert.equal(notificationIcon({ title: "手动关机", type: "manual" }), "🟢");
  assert.equal(notificationIcon({ title: "定时开机", type: "schedule" }), "🟢");
  assert.equal(notificationIcon({ title: "检测恢复", level: "warning" }), "🟠");
  assert.equal(
    notificationIcon({ title: "操作结果", type: "operation-error" }),
    "🔴",
  );
});

function runtime(t) {
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
  Object.assign(settings.notifications, {
    telegramToken: "fixture-token",
    telegramChatId: "fixture-chat",
  });
  r.store.saveSettings(settings);
  r.notify.sendOverride = async () => {};
  return r;
}
function select(r, events) {
  const settings = r.store.settings();
  settings.notifications.events = events;
  r.store.saveSettings(settings);
}

test("旧通知模式转换为勾选项，空选择不回退默认，日报无重复开关", (t) => {
  const r = runtime(t);
  for (const mode of ["events", "errors", "always", "off"]) {
    const s = r.store.settings();
    delete s.notifications.events;
    s.notifications.mode = mode;
    s.dailyReport = true;
    r.store.saveSettings(s);
    const visible = r.store.publicSettings();
    assert.equal(visible.notifications.mode, undefined);
    assert.deepEqual(visible.notifications.events, notificationSelection(s));
    assert.equal(
      visible.notifications.events.includes("daily"),
      mode !== "off",
    );
    assert.equal(
      visible.notifications.events.includes("cycle"),
      mode === "always",
    );
    assert.equal(
      visible.notifications.events.includes("keepalive"),
      ["events", "always"].includes(mode),
    );
  }
  select(r, []);
  assert.deepEqual(r.store.publicSettings().notifications.events, []);
  assert.equal(r.store.settings().dailyReport, false);
  select(r, ["daily", "daily"]);
  assert.deepEqual(r.store.settings().notifications.events, ["daily"]);
  assert.equal(r.store.settings().dailyReport, true);
});

test("新配置启用关键通知和每日汇总，保存后的自选和空选不会被默认覆盖", (t) => {
  const r = runtime(t);
  assert.deepEqual(r.store.publicSettings().notifications.events, [
    "keepalive",
    "traffic",
    "operation-error",
    "daily",
  ]);
  assert.deepEqual(
    r.store.settings().notifications.events,
    defaultNotificationTypes,
  );
  assert.equal(r.store.settings().dailyReport, true);
  select(r, ["daily", "schedule"]);
  assert.deepEqual(r.store.publicSettings().notifications.events, [
    "daily",
    "schedule",
  ]);
  select(r, []);
  assert.deepEqual(r.store.publicSettings().notifications.events, []);
});

test("每个自动通知类型有对应示例，按单独勾选准确筛选包括错误汇总", () => {
  const auto = notificationExamples.filter((i) => i.id !== "test");
  assert.deepEqual(
    new Set(auto.map((i) => i.id)),
    new Set(notificationChoices.map((i) => i.value)),
  );
  for (const example of auto) {
    assert.equal(notificationType(example.item), example.id);
    for (const choice of notificationChoices) {
      assert.equal(
        wantsNotification(
          { notifications: { events: [choice.value] } },
          example.item,
        ),
        choice.value === example.id,
      );
    }
  }
  assert.equal(
    wantsNotification(
      { notifications: { events: ["error"] } },
      { title: "检测完成", kind: "cycle", level: "error" },
    ),
    false,
  );
  for (const title of ["保活开机", "手动关机", "定时开机", "流量保护关机"])
    assert.equal(
      notificationType({ title, level: "error" }),
      "operation-error",
    );
});

test("实际队列只接收勾选类型，动作成功和失败可独立选择", (t) => {
  const r = runtime(t);
  select(r, ["operation-error", "billing-recovery", "traffic-recovery"]);
  for (const example of notificationExamples.filter((i) => i.id !== "test"))
    r.notify.event(
      example.id,
      example.item.title,
      example.item.message,
      example.item,
    );
  assert.deepEqual(
    new Set(r.store.list("outbox").map((i) => i.type)),
    new Set(["operation-error", "billing-recovery", "traffic-recovery"]),
  );
  assert.ok(r.store.list("outbox").every((i) => i.status === "queued"));
});

test("取消勾选跳过待投递消息，其他已勾选消息正常发送", async (t) => {
  const r = runtime(t);
  select(r, ["keepalive", "schedule", "daily"]);
  r.notify.event("keep", "保活开机", "已确认实例运行");
  r.notify.event("schedule", "定时关机", "已确认实例停止");
  r.notify.event("daily", "Aliyun 实例日报", "汇总", { kind: "report" });
  select(r, ["schedule"]);
  const sent = [];
  r.notify.sendOverride = async (item) => sent.push(item.id);
  await r.notify.tick();
  assert.deepEqual(sent, ["schedule:telegram"]);
  assert.equal(r.store.get("outbox", "keep:telegram").status, "skipped");
  assert.equal(r.store.get("outbox", "daily:telegram").status, "skipped");
});

test("全部取消后不推送自动通知，手动测试仍遵循 Telegram 总开关", async (t) => {
  const r = runtime(t);
  select(r, []);
  r.notify.event("failure", "检测异常", "timeout", { level: "error" });
  r.notify.event("report", "日报", "汇总", { kind: "report" });
  assert.equal(r.store.list("outbox").length, 0);
  assert.deepEqual(r.notify.test(), ["telegram"]);
  await r.notify.tick();
  assert.equal(r.store.list("outbox")[0].status, "sent");
  const s = r.store.settings();
  s.notifications.telegramEnabled = false;
  r.store.saveSettings(s);
  assert.deepEqual(r.notify.test(), []);
  assert.equal(r.store.list("outbox").length, 1);
});

test("每日汇总与每轮汇总分别勾选，日报持久去重并在取消后停止生成", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-14T16:00:00Z"),
  });
  const r = runtime(t);
  const s = r.store.settings();
  s.billingEnabled = false;
  r.store.saveSettings(s);
  select(r, ["daily"]);
  await r.service.refresh();
  await r.engine.reports();
  await r.engine.reports();
  assert.equal(
    r.store.list("outbox").filter((i) => i.kind === "report").length,
    1,
  );
  select(r, []);
  t.mock.timers.setTime(Date.now() + 86400000);
  await r.engine.reports();
  assert.equal(r.store.list("outbox").length, 1);
  select(r, ["cycle"]);
  await r.engine.cycle(true);
  assert.ok(r.store.list("outbox").some((i) => i.kind === "cycle"));
  const count = r.store.list("outbox").filter((i) => i.kind === "cycle").length;
  select(r, ["error"]);
  await r.engine.cycle(true);
  assert.equal(
    r.store.list("outbox").filter((i) => i.kind === "cycle").length,
    count,
  );
});

test("设置 API 验证类型、保存勾选项并保留已配置秘密", async (t) => {
  const r = runtime(t);
  const server = createServer(createApp(r, { dist: "not-built" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port;
  const login = await fetch(url + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "fixture-password-123" }),
  });
  const auth = await login.json();
  const headers = {
    cookie: login.headers.get("set-cookie").split(";")[0],
    "x-csrf-token": auth.csrf,
    "content-type": "application/json",
  };
  const s = r.store.publicSettings();
  delete s.notifications.telegramConfigured;
  s.notifications.events = ["daily", "keepalive"];
  s.dailyReport = false;
  const save = await fetch(url + "/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify(s),
  });
  assert.equal(save.status, 200);
  const result = await save.json();
  assert.deepEqual(result.notifications.events, ["daily", "keepalive"]);
  assert.equal(result.dailyReport, true);
  assert.equal(result.notifications.mode, undefined);
  assert.equal(result.notifications.telegramToken, "");
  assert.equal(r.store.settings().notifications.telegramToken, "fixture-token");
  s.notifications.events = ["unknown"];
  const invalid = await fetch(url + "/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify(s),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(r.store.publicSettings().notifications.events, [
    "daily",
    "keepalive",
  ]);
});
