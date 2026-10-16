import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./fixture.mjs";

function runtime(t) {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-15T16:00:00Z"),
  });
  const dir = mkdtempSync(join(tmpdir(), "aliyun-empty-test-"));
  const r = fixture(dir);
  t.after(() => {
    r.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const settings = r.store.settings();
  Object.assign(settings.notifications, {
    telegramToken: "fixture-token",
    telegramChatId: "fixture-chat",
    events: ["cycle", "daily"],
  });
  r.store.saveSettings(settings);
  return r;
}

function setMonitors(r, monitors) {
  const { credentials, ...account } = r.store.account(r.account.id);
  r.store.saveAccount({ ...account, monitors }, credentials, account.id);
}

test("移除全部实例后不查询云端、不刷空检测日志、不生成汇总，重新接入后恢复", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const { credentials, ...account } = r.store.account(r.account.id);
  r.store.deleteAccount(account.id);
  const calls = r.calls.length;
  const audit = r.store.logs().length;
  r.engine.lastCycle = Date.now();
  await r.engine.cycle();
  await r.engine.cycle(true);
  await r.engine.reports();
  assert.equal(r.calls.length, calls);
  assert.equal(r.store.logs().length, audit);
  assert.equal(r.store.list("outbox").length, 0);
  r.store.saveAccount(account, credentials, account.id);
  await r.engine.cycle();
  await r.engine.reports();
  assert.ok(r.calls.length > calls);
  assert.ok(r.store.list("outbox").some((i) => i.kind === "cycle"));
  assert.equal(
    r.store.list("outbox").filter((i) => i.kind === "report").length,
    1,
  );
});

test("保留凭证但监控列表为空时不查询 ECS、流量或账单，手动测试通知仍可用", async (t) => {
  const r = runtime(t);
  setMonitors(r, []);
  await r.engine.cycle(true);
  await r.engine.reports();
  assert.equal(r.calls.length, 0);
  assert.equal(r.store.logs().length, 0);
  assert.equal(r.store.list("outbox").length, 0);
  assert.deepEqual(r.notify.test(), ["telegram"]);
});

test("已配置实例首次查询失败仍继续发现，空日报不占用日期，恢复后正常发送", async (t) => {
  const r = runtime(t);
  setMonitors(r, [{ id: "i-web", region: "cn-hongkong" }]);
  const discover = r.gateway.instances.bind(r.gateway);
  let attempts = 0;
  r.gateway.instances = async () => {
    attempts++;
    throw new Error("fixture DNS failure");
  };
  await r.engine.cycle(true);
  await r.engine.reports();
  assert.equal(attempts, 1);
  assert.equal(
    r.store.list("outbox").filter((i) => i.kind === "report").length,
    0,
  );
  t.mock.timers.setTime(Date.now() + 60000);
  await r.engine.cycle();
  assert.equal(attempts, 2);
  r.gateway.instances = discover;
  await r.engine.cycle(true);
  await r.engine.reports();
  await r.engine.reports();
  const reports = r.store.list("outbox").filter((i) => i.kind === "report");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].title, "Aliyun 实例日报 2026-10-16");
});

test("筛选范围内无接入实例时不查询其他地域，也不生成空每轮汇总", async (t) => {
  const r = runtime(t);
  setMonitors(r, [{ id: "i-web", region: "cn-hongkong" }]);
  await r.engine.cycle(true, { region: "cn-hangzhou" });
  assert.equal(r.calls.length, 0);
  assert.equal(r.store.list("outbox").length, 0);
});
