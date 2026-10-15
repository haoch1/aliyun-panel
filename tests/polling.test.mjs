import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { createServer } from "node:http";
import { fixture } from "./fixture.mjs";
import { createApp } from "../server/app.mjs";

function runtime(t) {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-test-"));
  const r = fixture(dir);
  const settings = r.store.settings();
  Object.assign(settings, { checkInterval: 900, billingEnabled: false });
  r.store.saveSettings(settings);
  t.after(() => {
    r.engine.stop();
    r.store.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + "aliyun-test-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  return r;
}

async function settle(r) {
  if (r.engine.cyclePromise) await r.engine.cyclePromise;
  await immediate();
}

test("实际后台计时器遵守 15 分钟间隔，5/10 分钟没有隐藏发现查询", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setInterval"],
    now: Date.parse("2026-10-15T02:05:00Z"),
  });
  const r = runtime(t);
  r.engine.start();
  await settle(r);
  assert.equal(
    r.calls.filter((c) => c.action === "DescribeInstances").length,
    2,
  );
  assert.equal(
    r.calls.filter((c) => c.action === "ListCdtInternetTraffic").length,
    1,
  );
  r.calls.length = 0;
  for (const elapsed of [300000, 300000, 299999]) {
    t.mock.timers.tick(elapsed);
    await settle(r);
    assert.equal(r.calls.length, 0);
  }
  t.mock.timers.tick(1);
  await settle(r);
  assert.equal(
    r.calls.filter((c) => c.action === "DescribeInstances").length,
    2,
  );
  assert.equal(
    r.calls.filter((c) => c.action === "ListCdtInternetTraffic").length,
    1,
  );
  assert.ok(
    r.calls.every((c) =>
      ["DescribeInstances", "ListCdtInternetTraffic"].includes(c.action),
    ),
  );
});

test("启动已有缓存时只查询一次状态和月流量，不重复进行全量发现", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.gateway.invalidate();
  r.calls.length = 0;
  r.engine.start();
  await settle(r);
  assert.equal(
    r.calls.filter((c) => c.action === "DescribeInstances").length,
    2,
  );
  assert.equal(
    r.calls.filter((c) => c.action === "ListCdtInternetTraffic").length,
    1,
  );
  assert.equal(r.calls.filter((c) => c.action === "DescribeRegions").length, 0);
});

test("正常轮询同时更新 EIP 绑定和实例元数据，不追加发现请求", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const rpc = r.gateway.rpc;
  r.gateway.rpc = async (...args) => {
    const body = await rpc(...args);
    if (args[2] === "DescribeInstances")
      for (const i of body.instances.instance)
        if (i.instanceId === "i-web") {
          i.instanceName = "已更新的名称";
          i.eipAddress = { ipAddress: "203.0.113.99", allocationId: "eip-new" };
        }
    return body;
  };
  r.calls.length = 0;
  await r.service.statusCycle();
  const item = r.service.instance({
    accountId: "account-test",
    region: "cn-hongkong",
    id: "i-web",
  });
  assert.equal(item.name, "已更新的名称");
  assert.equal(item.publicNetwork, "eip");
  assert.equal(item.eipAllocationId, "eip-new");
  assert.ok(item.ip.includes("203.0.113.99"));
  assert.equal(
    r.calls.filter((c) => c.action === "DescribeInstances").length,
    2,
  );
});

test("初次发现失败的地域仍可在后续轮询恢复", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const key = JSON.stringify(["account-test", "cn-hongkong"]);
  r.store.put("scope", key, {
    accountId: "account-test",
    region: "cn-hongkong",
    items: [],
    error: "temporary",
    discoveryError: "temporary",
    at: 0,
  });
  await r.service.statusCycle();
  assert.equal(r.store.get("scope", key).items.length, 2);
  assert.equal(r.store.get("scope", key).error, undefined);
});

test("网页刷新并检查规则只进行一轮云端查询", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const server = createServer(createApp(r, { dist: "not-built" }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const url = "http://127.0.0.1:" + server.address().port;
  const setup = await fetch(url + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "fixture-password-123" }),
  });
  const auth = await setup.json();
  r.gateway.invalidate();
  r.calls.length = 0;
  const response = await fetch(url + "/api/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: setup.headers.get("set-cookie").split(";")[0],
      "x-csrf-token": auth.csrf,
    },
    body: JSON.stringify({ check: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    r.calls.filter((c) => c.action === "DescribeInstances").length,
    2,
  );
  assert.equal(
    r.calls.filter((c) => c.action === "ListCdtInternetTraffic").length,
    1,
  );
});
