import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fixture } from "./fixture.mjs";
const tResource = {
  accountId: "account-test",
  region: "cn-hongkong",
  id: "i-data",
};
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
test("只刷新受保护实例的用量不丢失其他实例数据", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const before = r.service
    .instances()
    .items.find((i) => i.id === "i-web").usage;
  r.store.saveRule(tResource, { thresholdEnabled: true, thresholdPercent: 90 });
  await r.service.statusCycle();
  assert.equal(
    r.service.instances().items.find((i) => i.id === "i-web").usage.used,
    before.used,
  );
});
test("延迟状态查询不覆盖新发现实例及更新后的名称", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const original = r.gateway.statuses.bind(r.gateway);
  let release, entered;
  const enteredPromise = new Promise((resolve) => (entered = resolve));
  r.gateway.statuses = async (a, reg, ids) => {
    if (reg !== "cn-hongkong") return original(a, reg, ids);
    const result = await original(a, reg, ids);
    entered();
    return new Promise((resolve) => {
      release = () => resolve(result);
    });
  };
  const checking = r.service.statusCycle();
  await enteredPromise;
  r.extraRows.push({
    instanceId: "i-later",
    instanceName: "new-name",
    regionId: "cn-hongkong",
    publicIpAddress: "192.0.2.40",
  });
  r.state.set("i-later", "Running");
  const instances = r.gateway.instances.bind(r.gateway);
  r.gateway.instances = async (...args) =>
    (await instances(...args)).map((i) =>
      i.id === "i-web"
        ? {
            ...i,
            name: "fresh-name",
            eipAllocationId: "eip-fresh",
            publicNetwork: "eip",
          }
        : i,
    );
  await r.service.refresh({ accountId: "account-test", region: "cn-hongkong" });
  release();
  await checking;
  assert.equal(
    r.service.instances().items.find((i) => i.id === "i-later").name,
    "new-name",
  );
  const web = r.service.instances().items.find((i) => i.id === "i-web");
  assert.equal(web.name, "fresh-name");
  assert.equal(web.eipAllocationId, "eip-fresh");
});
test("单实例状态恢复不会将同地域其他失败状态标成新鲜", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const original = r.gateway.statuses.bind(r.gateway);
  r.gateway.statuses = async () => {
    throw new Error("temporary");
  };
  await r.service.statusCycle();
  r.gateway.statuses = original;
  await r.service.refreshTarget(tResource);
  const items = r.service.instances().items;
  assert.ok(items.find((i) => i.id === "i-data").statusAt);
  assert.equal(items.find((i) => i.id === "i-web").statusAt, 0);
});
test("第二次状态核对期间修改规则仍取消云端写操作", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const rule = r.store.saveRule(tResource, { keepAlive: true }),
    job = r.jobs.enqueue(tResource, "start", "keepalive", {
      revision: rule.revision,
    });
  const original = r.service.refreshTarget.bind(r.service);
  let reads = 0;
  r.service.refreshTarget = async (...args) => {
    const i = await original(...args);
    if (++reads === 2) r.store.saveRule(tResource, { keepAlive: false });
    return i;
  };
  await r.jobs.run(r.store.get("job", job.id));
  assert.equal(r.store.get("job", job.id).status, "failed");
  assert.equal(
    r.calls.some((c) => c.action === "StartInstance"),
    false,
  );
});
test("定时开机记录只在确认成功后保存，重启恢复任务不会重放请求", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const rule = r.store.saveRule(tResource, { keepAlive: true }),
    job = r.jobs.enqueue(tResource, "start", "keepalive", {
      revision: rule.revision,
      scheduleKey: "2026-10-14:08:00",
    });
  await r.jobs.run(r.store.get("job", job.id));
  assert.equal(r.store.rule(tResource).lastSchedule, "2026-10-14:08:00");
  const writes = r.calls.filter((c) => c.action === "StartInstance").length;
  const completed = r.store.get("job", job.id);
  await r.jobs.run({ ...completed, status: "submitted" });
  assert.equal(
    r.calls.filter((c) => c.action === "StartInstance").length,
    writes,
  );
});
test("告警投递重试去重，通道失败不改变关机成功状态", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const s = r.store.settings();
  s.notifications.telegramToken = "fixture-token";
  s.notifications.telegramChatId = "fixture-chat";
  s.notifications.events.push("manual");
  r.store.saveSettings(s);
  const tWeb = { ...tResource, id: "i-web" },
    job = await r.jobs.manual(tWeb, "stop");
  await r.jobs.run(r.store.get("job", job.id));
  r.notify.sendOverride = async () => {
    throw new Error("temporary");
  };
  await r.notify.tick();
  assert.equal(r.store.get("job", job.id).status, "success");
  const out = r.store.list("outbox")[0];
  assert.equal(out.attempts, 1);
  r.notify.event("job:" + job.id + ":success", "again", "again");
  assert.equal(r.store.list("outbox").length, 1);
  r.store.put("outbox", out.id, { ...out, nextAt: 0 });
  r.notify.sendOverride = async () => {};
  await r.notify.tick();
  assert.equal(r.store.get("outbox", out.id).status, "sent");
});
