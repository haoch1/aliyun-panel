import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fixture } from "./fixture.mjs";
import { ResourceService } from "../server/service.mjs";
import { createApp } from "../server/app.mjs";
const target = {
  accountId: "account-test",
  region: "cn-hongkong",
  id: "i-web",
};
const minute = 60000,
  base = Date.parse("2026-10-15T00:00:00+08:00");
async function runtime(t, eip = true) {
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const dir = mkdtempSync(join(tmpdir(), "aliyun-snapshot-test-")),
    r = fixture(dir);
  const rpc = r.gateway.rpc;
  r.gateway.rpc = async (...args) => {
    const body = await rpc(...args);
    if (eip && args[2] === "DescribeInstances")
      for (const i of body.instances.instance)
        i.eipAddress = {
          allocationId: "eip-" + i.instanceId,
          ipAddress: "192.0.2.12",
        };
    return body;
  };
  r.advance = (n) => t.mock.timers.setTime(Date.now() + n * minute);
  t.after(async () => {
    await Promise.all(r.service.trafficReads.values());
    r.store.close();
    assert.ok(
      resolve(dir).startsWith(
        resolve(tmpdir()) + sep + "aliyun-snapshot-test-",
      ),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  await r.service.refresh();
  r.advance(eip ? 10 : 90);
  r.saved = await r.service.traffic(target, "month");
  return r;
}

for (const eip of [true, false])
  test(`${eip ? "EIP" : "ECS"} 已保存快照直接返回，慢云端查询在后台合并，CDT 不额外查询`, async (t) => {
    const r = await runtime(t, eip),
      monitor = r.gateway.monitor.bind(r.gateway);
    const usage = () =>
      r.calls.filter((c) => c.action === "ListCdtInternetTraffic").length;
    const before = usage();
    r.advance(eip ? 6 : 60);
    let release, entered;
    const held = new Promise((r) => (release = r)),
      ready = new Promise((r) => (entered = r));
    r.gateway.monitor = async (...args) => {
      entered();
      await held;
      return monitor(...args);
    };
    const first = r.service.readTraffic(target, "month");
    assert.deepEqual(first.items, r.saved.items);
    assert.equal(typeof first.then, "undefined");
    await ready;
    try {
      for (let n = 0; n < 20; n++) {
        const i = r.service
          .instances({}, { traffic: true })
          .items.find((i) => i.id === target.id);
        assert.deepEqual(i.traffic.items, r.saved.items);
        assert.deepEqual(
          r.service.readTraffic(target, "month").items,
          r.saved.items,
        );
      }
      assert.equal(r.service.trafficReads.size, 1);
      assert.equal(usage(), before);
    } finally {
      release();
    }
    await Promise.all(r.service.trafficReads.values());
    const updated = r.service.readTraffic(target, "month");
    assert.ok(
      updated.items.reduce((n, i) => n + i.outBytes, 0) >
        first.items.reduce((n, i) => n + i.outBytes, 0),
    );
    assert.equal(usage(), before);
  });

test("实例和流量 HTTP 接口在云端挂起时仍返回旧值，更新完成后读到新值", async (t) => {
  const r = await runtime(t),
    monitor = r.gateway.monitor.bind(r.gateway);
  r.store.setPassword("snapshot-test-password");
  const session = r.store.createSession(12);
  const server = createApp(r, { dist: "dist", testMode: true }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const get = (path) =>
    fetch(url + "/api" + path, {
      headers: { cookie: "aliyun_panel_session=" + session.token },
      signal: AbortSignal.timeout(2000),
    }).then(async (res) => {
      assert.equal(res.status, 200);
      return res.json();
    });
  const path = "/traffic?" + new URLSearchParams({ ...target, days: "month" });
  r.advance(6);
  let release;
  const held = new Promise((r) => (release = r));
  r.gateway.monitor = async (...args) => {
    await held;
    return monitor(...args);
  };
  try {
    const instances = await get("/instances");
    assert.deepEqual(
      instances.items.find((i) => i.id === target.id).traffic.items,
      r.saved.items,
    );
    const traffic = await get(path);
    assert.deepEqual(traffic.items, r.saved.items);
    assert.deepEqual(traffic.errors, []);
    assert.equal(r.service.trafficReads.size, 1);
  } finally {
    release();
  }
  await Promise.all(r.service.trafficReads.values());
  assert.notDeepEqual((await get(path)).items, r.saved.items);
});

test("后台失败仍显示已有流量和错误，冷却期间重新进入不重试，恢复后清除错误", async (t) => {
  const r = await runtime(t),
    monitor = r.gateway.monitor.bind(r.gateway);
  let attempts = 0;
  r.gateway.monitor = async () => {
    attempts++;
    throw Error("Forbidden: fixture monitor denied");
  };
  r.advance(6);
  assert.deepEqual(r.service.readTraffic(target, "month").items, r.saved.items);
  await Promise.all(r.service.trafficReads.values());
  const before = attempts;
  const restarted = new ResourceService(r.store, r.gateway);
  for (const days of ["month", 7, 30]) {
    const saved = restarted.readTraffic(target, days);
    assert.match(saved.errors[0], /Forbidden/);
    assert.deepEqual(saved.items, r.saved.items);
  }
  await Promise.all(restarted.trafficReads.values());
  assert.equal(attempts, before);
  r.advance(6);
  r.gateway.monitor = monitor;
  r.service.readTraffic(target, "month");
  await Promise.all(r.service.trafficReads.values());
  const fresh = r.service.readTraffic(target, "month");
  assert.deepEqual(fresh.errors, []);
});

test("重启直接使用数据库快照，跨月和跨日范围不沿用旧月份流量", async (t) => {
  const r = await runtime(t),
    restarted = new ResourceService(r.store, r.gateway);
  assert.deepEqual(
    restarted
      .instances({}, { traffic: true })
      .items.find((i) => i.id === target.id).traffic.items,
    r.saved.items,
  );
  t.mock.timers.setTime(Date.parse("2026-11-01T00:01:00+08:00"));
  const current = restarted
    .instances({}, { traffic: true })
    .items.find((i) => i.id === target.id).traffic;
  assert.deepEqual(current.items, []);
  assert.equal(current.start, Date.parse("2026-11-01T00:00:00+08:00"));
  assert.equal(current.end, Date.now());
});

test("元数据错误可见并持久冷却，不因 SSE 重读形成重试循环", async (t) => {
  const r = await runtime(t);
  const scopes = r.store.list("scope");
  const scope = scopes.find((s) => s.region === target.region);
  scope.items.find((i) => i.id === target.id).eipAllocationId = undefined;
  const key = JSON.stringify([target.accountId, target.region]);
  r.store.put("scope", key, scope);
  const before = r.calls.length;
  r.service.readTraffic(target, "month");
  await Promise.all(r.service.trafficReads.values());
  const restarted = new ResourceService(r.store, r.gateway);
  for (let n = 0; n < 10; n++) {
    const saved = restarted.readTraffic(target, "month");
    assert.match(saved.errors[0], /EIP 标识尚未同步/);
  }
  assert.equal(restarted.trafficReads.size, 0);
  assert.equal(r.calls.length, before);
  scope.items.find((i) => i.id === target.id).eipAllocationId = "eip-i-web";
  r.store.put("scope", key, scope);
  assert.deepEqual(restarted.readTraffic(target, "month").errors, []);
  await Promise.all(restarted.trafficReads.values());
  assert.equal(
    r.store.get("traffic-read-error", JSON.stringify(Object.values(target))),
    null,
  );
});
