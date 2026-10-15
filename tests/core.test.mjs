import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { createServer } from "node:http";
import { fixture } from "./fixture.mjs";
import { defaultRule, Store } from "../server/store.mjs";
import { decide, inWindow } from "../server/policy.mjs";
import { createApp } from "../server/app.mjs";
import { AliyunGateway } from "../server/aliyun.mjs";
test("STS 与余额接口使用官方无请求体签名，凭证变更不复用旧客户端", async () => {
  const a = {
      id: "a",
      credentials: { accessKeyId: "fixture", accessKeySecret: "first" },
    },
    g = new AliyunGateway({ account: () => a });
  const c = g.client("sts", a, "cn-hangzhou");
  let captured;
  c.getCallerIdentityWithOptions = async (runtime) => {
    captured = runtime;
    return { body: { accountId: "owner" } };
  };
  assert.equal(
    (
      await g.call(
        "a",
        "cn-hangzhou",
        "GetCallerIdentity",
        {},
        { product: "sts" },
      )
    ).accountId,
    "owner",
  );
  assert.equal(captured.readTimeout, 15000);
  const b = g.client("bss", a, "cn-hangzhou");
  b.queryAccountBalanceWithOptions = async (runtime) => ({
    body: { data: { currency: "CNY" }, runtime },
  });
  assert.equal(
    (
      await g.call(
        "a",
        "cn-hangzhou",
        "QueryAccountBalance",
        {},
        { product: "bss" },
      )
    ).data.currency,
    "CNY",
  );
  assert.notEqual(
    g.client(
      "sts",
      { ...a, credentials: { ...a.credentials, accessKeySecret: "second" } },
      "cn-hangzhou",
    ),
    c,
  );
});
function cleanTemp(dir) {
  const absolute = resolve(dir),
    root = resolve(tmpdir()) + sep;
  assert.ok(
    absolute.toLowerCase().startsWith(root.toLowerCase()) &&
      /^aliyun-(test|restore)-/.test(basename(absolute)),
    "清理范围必须是本测试生成的临时目录",
  );
  rmSync(absolute, { recursive: true, force: true });
}
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-test-")),
    r = fixture(dir);
  t.after(() => {
    r.store.close();
    cleanTemp(dir);
  });
  return { ...r, dir };
}
const target = {
  accountId: "account-test",
  region: "cn-hongkong",
  id: "i-data",
};
const now = Date.parse("2026-10-14T12:00:00+08:00");
test("保活服从人工、时段、熔断、暂停和未知状态", () => {
  const rule = { ...defaultRule(target), keepAlive: true },
    i = { status: "Stopped", expires: "2030-01-01" },
    s = { keepAliveDefault: false };
  assert.equal(decide(i, rule, s, { now }).action, "start");
  for (const changes of [
    { hold: "manual" },
    { hold: "traffic" },
    { paused: true },
    { scheduleEnabled: true, start: "13:00", stop: "14:00" },
  ])
    assert.notEqual(
      decide(i, { ...rule, ...changes }, s, { now }).action,
      "start",
    );
  assert.equal(
    decide(i, rule, s, { now, statusFresh: false }).action,
    undefined,
  );
  assert.equal(
    decide({ ...i, status: "Starting" }, rule, s, { now }).action,
    undefined,
  );
  assert.equal(
    decide({ ...i, expires: "2026-01-01" }, rule, s, { now }).action,
    undefined,
  );
});
test("跨午夜时段、定时开机与数据错误", () => {
  assert.equal(inWindow("23:00", "22:00", "06:00"), true);
  assert.equal(inWindow("06:00", "22:00", "06:00"), false);
  const r = {
      ...defaultRule(target),
      keepAlive: false,
      scheduleEnabled: true,
      start: "12:00",
      stop: "13:00",
    },
    i = { status: "Stopped" };
  assert.equal(
    decide(i, r, { keepAliveDefault: false }, { now }).action,
    "start",
  );
  assert.equal(
    decide(
      i,
      { ...r, lastSchedule: "2026-10-14:12:00" },
      { keepAliveDefault: false },
      { now },
    ).action,
    undefined,
  );
  const guarded = { ...r, thresholdEnabled: true };
  assert.equal(decide(i, guarded, {}, { now }).action, undefined);
  const error = {
    used: 0,
    total: 100,
    quota: "finite",
    at: now,
    error: "temporary",
  };
  assert.equal(
    decide({ ...i, usage: error }, guarded, {}, { now }).action,
    undefined,
  );
  assert.equal(
    decide(
      { status: "Running", usage: error },
      { ...guarded, start: "01:00", stop: "02:00" },
      {},
      { now },
    ).action,
    "stop",
  );
});
test("出网阈值触发熔断，跨月和用量降低不自动解除", () => {
  const r = { ...defaultRule(target), keepAlive: true, thresholdEnabled: true },
    i = {
      status: "Running",
      usage: { used: 90, total: 100, quota: "finite", at: now },
    };
  assert.deepEqual(Object.assign({}, decide(i, r, {}, { now })), {
    reason: "达到流量阈值",
    notify: true,
    latch: true,
    action: "stop",
    source: "traffic",
  });
  assert.equal(
    decide(
      {
        ...i,
        status: "Stopped",
        usage: { ...i.usage, used: 0, at: now + 31 * 86400000 },
      },
      { ...r, hold: "traffic" },
      {},
      { now: now + 31 * 86400000 },
    ).action,
    undefined,
  );
});
test("手动关机禁令持久化，重启后保活仍不会拉起", async (t) => {
  const r = setup(t);
  await r.service.refresh();
  r.store.saveRule(target, { keepAlive: true });
  r.state.set("i-data", "Running");
  const j = await r.jobs.manual(target, "stop");
  await r.jobs.run(r.store.get("job", j.id));
  assert.equal(r.store.get("job", j.id).status, "success");
  assert.equal(r.store.rule(target).hold, "manual");
  const store2 = new Store(r.dir);
  try {
    assert.equal(store2.rule(target).hold, "manual");
  } finally {
    store2.close();
  }
  await r.engine.cycle();
  assert.equal(r.calls.filter((x) => x.action === "StartInstance").length, 0);
});
test("保活执行官方启动调用，人工开机成功后解锁", async (t) => {
  const r = setup(t);
  await r.service.refresh();
  r.store.saveRule(target, { keepAlive: true });
  await r.engine.cycle();
  const j = r.store.list("job").find((j) => j.source === "keepalive");
  assert.ok(j);
  await r.jobs.run(j);
  assert.equal(r.state.get("i-data"), "Running");
  const call = r.calls.find((c) => c.action === "StartInstance");
  assert.equal(call.params.regionId, "cn-hongkong");
  assert.equal(call.params.clientToken, undefined);
  assert.equal(call.options.write, true);
  assert.equal(r.store.get("job", j.id).status, "success");
});
test("规则修改取消未提交动作，云写请求不发生", async (t) => {
  const r = setup(t);
  await r.service.refresh();
  const rule = r.store.saveRule(target, { keepAlive: true });
  const j = r.jobs.enqueue(target, "start", "keepalive", {
    revision: rule.revision,
  });
  r.store.saveRule(target, { keepAlive: false });
  await r.jobs.run(r.store.get("job", j.id));
  assert.equal(r.store.get("job", j.id).status, "failed");
  assert.ok(!r.calls.some((c) => c.action === "StartInstance"));
});
test("网络未知结果保留任务，不重复提交写请求", async (t) => {
  const r = setup(t);
  await r.service.refresh();
  let writes = 0;
  r.gateway.control = async () => {
    writes++;
    throw new Error("socket timeout");
  };
  const j = await r.jobs.manual(target, "start");
  await r.jobs.run(r.store.get("job", j.id));
  assert.equal(r.store.get("job", j.id).status, "attention");
  r.jobs.tick();
  assert.equal(writes, 1);
  assert.ok(r.jobs.busy(target));
});
test("账号删除期间的旧查询不能恢复资源", async (t) => {
  const r = setup(t);
  let release;
  r.gateway.instances = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = r.service.refresh({
    accountId: "account-test",
    region: "cn-hongkong",
  });
  await new Promise((resolve) => setImmediate(resolve));
  r.store.deleteAccount("account-test");
  release([{ ...target, status: "Running" }]);
  await pending;
  assert.equal(r.service.instances().items.length, 0);
});
test("账单分页完整、实例筛选、失败状态由独立通道处理", async (t) => {
  const r = setup(t);
  let page = 0;
  r.gateway.rpc = async (_a, _r, action, p) =>
    action === "QueryAccountBalance"
      ? { data: { availableAmount: "100.00", currency: "CNY" } }
      : {
          data: {
            items: [
              { instanceID: "i-data", pretaxAmount: ++page },
              { instanceID: "unmanaged", pretaxAmount: 100 },
            ],
            nextToken: page === 1 ? "next" : undefined,
          },
        };
  const b = await r.gateway.billing(
    "account-test",
    "cn-hongkong",
    ["i-data"],
    "2026-10",
  );
  assert.equal(b.items.length, 2);
  assert.equal(
    b.items.reduce((s, x) => s + x.pretaxAmount, 0),
    3,
  );
});
test("官方 SDK 初始化和写请求模型参数", async () => {
  const g = new AliyunGateway({
      account: () => ({
        id: "a",
        credentials: { accessKeyId: "fixture", accessKeySecret: "fixture" },
      }),
    }),
    a = {
      id: "a",
      credentials: { accessKeyId: "fixture", accessKeySecret: "fixture" },
    };
  const c = g.client("ecs", a, "cn-hongkong");
  assert.equal(c._endpoint, "ecs.cn-hongkong.aliyuncs.com");
  let captured;
  c.stopInstanceWithOptions = async (req, runtime) => {
    captured = { req, runtime };
    return { body: { requestId: "ok" } };
  };
  await g.control(
    { accountId: "a", region: "cn-hongkong", id: "i-test" },
    "stop",
    "same-token",
  );
  assert.equal(captured.req.clientToken, undefined);
  assert.equal(captured.req.stoppedMode, "KeepCharging");
  assert.equal(captured.req.forceStop, false);
  assert.equal(c._retryOptions.retryable, false);
  assert.equal(captured.runtime.connectTimeout, 5000);
});
test("HTTP 认证、CSRF、来源、保活保存与秘密结果保护", async (t) => {
  const r = setup(t);
  await r.service.refresh();
  const app = createApp(r, { dist: "not-built" }),
    server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(url + "/api/accounts")).status, 401);
  const login = await fetch(url + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "admin-password-123" }),
  });
  assert.equal(login.status, 200);
  const auth = await login.json(),
    cookie = login.headers.get("set-cookie").split(";")[0],
    headers = {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": auth.csrf,
    };
  const value = { target, rule: { ...defaultRule(target), keepAlive: true } };
  delete value.rule.accountId;
  delete value.rule.id;
  delete value.rule.region;
  assert.equal(
    (
      await fetch(url + "/api/rules", {
        method: "PUT",
        headers: { ...headers, "x-csrf-token": "bad" },
        body: JSON.stringify(value),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + "/api/rules", {
        method: "PUT",
        headers: { ...headers, origin: "https://evil.invalid" },
        body: JSON.stringify(value),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + "/api/rules", {
        method: "PUT",
        headers,
        body: JSON.stringify(value),
      })
    ).status,
    200,
  );
  const data = await (await fetch(url + "/api/instances", { headers })).json();
  assert.equal(
    data.items.find((x) => x.id === "i-data").effectiveKeepAlive,
    true,
  );
  assert.ok(!JSON.stringify(data).includes("fixture-secret"));
  const accountData = await (
    await fetch(url + "/api/accounts", { headers })
  ).json();
  assert.equal(accountData.items[0].credentials, undefined);
});
test("全局默认保活开启，CDT 同账号缓存且区分内地与非内地池", async (t) => {
  const r = setup(t);
  const raw = new Store(r.dir);
  try {
    raw.db.prepare("DELETE FROM config WHERE key='settings'").run();
    assert.equal(raw.settings().keepAliveDefault, true);
  } finally {
    raw.close();
  }
  const [a, b, c] = await Promise.all([
    r.gateway.usage("account-test", "cn-hongkong", ["i-web"]),
    r.gateway.usage("account-test", "ap-southeast-1", ["i-data"]),
    r.gateway.usage("account-test", "cn-hangzhou", ["i-edge"]),
  ]);
  assert.equal(a[0].trafficUsed, b[0].trafficUsed);
  assert.equal(a[0].trafficPackageTotal, 200 * 1024 ** 3);
  assert.equal(c[0].trafficPackageTotal, 20 * 1024 ** 3);
  assert.equal(c[0].scope, "account");
  assert.equal(
    r.calls.filter((c) => c.action === "ListCdtInternetTraffic").length,
    1,
  );
  r.gateway.invalidate();
  r.gateway.rpc = async () => ({ trafficDetails: [] });
  await assert.rejects(
    r.gateway.usage("account-test", "cn-hongkong", ["i-web"]),
    /CDT 未返回/,
  );
});

test("ECS 两种停机模式显式传入，禁止强制关机和非 ECS ID", async () => {
  const account = {
    id: "a",
    credentials: { accessKeyId: "fixture", accessKeySecret: "fixture" },
  };
  const g = new AliyunGateway({ account: () => account }),
    client = g.client("ecs", account, "cn-hongkong");
  const calls = [];
  client.stopInstanceWithOptions = async (req, runtime) => {
    calls.push({ req, runtime });
    return { body: { requestId: "offline" } };
  };
  for (const stoppedMode of ["KeepCharging", "StopCharging"])
    await g.control(
      { accountId: "a", region: "cn-hongkong", id: "i-test" },
      "stop",
      "token",
      { stoppedMode },
    );
  assert.deepEqual(
    calls.map((c) => c.req.stoppedMode),
    ["KeepCharging", "StopCharging"],
  );
  assert.ok(
    calls.every((c) => c.req.forceStop === false && !c.runtime.autoretry),
  );
  await assert.rejects(
    g.control({ accountId: "a", region: "cn-hongkong", id: "swas-id" }, "stop"),
    /不是 ECS/,
  );
  assert.equal(calls.length, 2);
});

test("ECS 监控为区间 kbits，不乘时长，同次入出查询复用", async (t) => {
  const r = setup(t);
  await r.service.refresh();
  r.gateway.rpc = async (_a, _r, action, p) => {
    if (action === "ListCdtInternetTraffic")
      return {
        trafficDetails: [{ businessRegionId: "cn-hongkong", traffic: 1 }],
      };
    if (action === "DescribeInstanceMonitorData") {
      assert.match(p.startTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(p.endTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.ok(Date.parse(p.endTime) > Date.parse(p.startTime));
      assert.ok(
        Date.parse(p.endTime) - Date.parse(p.startTime) <= 400 * 3600000,
      );
      return {
        monitorData: {
          instanceMonitorData: [
            { timeStamp: p.endTime, internetTX: 8, internetRX: 16 },
          ],
        },
      };
    }
    throw new Error(action);
  };
  // At midnight the current day has no completed hourly interval yet.
  // Include yesterday so the unit conversion is tested at any clock time.
  const d = await r.service.traffic(target, 2);
  assert.ok(d.items.length);
  const day = d.items[0];
  assert.equal(day.outBytes, 1024);
  assert.equal(day.inBytes, 2048);
});
test("真实 SDK 响应模型解析 ECS 元数据与 CDT 池，未访问网络", async () => {
  const account = {
    id: "a",
    name: "account",
    site: "china",
    credentials: { accessKeyId: "fixture", accessKeySecret: "fixture" },
  };
  const g = new AliyunGateway({ account: () => account });
  let ecsQuery, cdtAction;
  g.client("ecs", account, "cn-hongkong").callApi = async (p, req) => {
    ecsQuery = req.query;
    return {
      body: {
        TotalCount: 1,
        Instances: {
          Instance: [
            {
              InstanceId: "i-test",
              InstanceName: "web",
              Status: "Running",
              PublicIpAddress: { IpAddress: ["192.0.2.10"] },
              InstanceChargeType: "PostPaid",
              SpotStrategy: "NoSpot",
            },
          ],
        },
      },
    };
  };
  const items = await g.instances("a", "cn-hongkong", ["i-test"]);
  assert.equal(items[0].id, "i-test");
  assert.deepEqual(items[0].ip, ["192.0.2.10"]);
  assert.equal(ecsQuery.InstanceIds, '["i-test"]');
  g.client("cdt", account, "cn-hongkong").callApi = async (p) => {
    cdtAction = p.action;
    return {
      body: {
        TrafficDetails: [
          { BusinessRegionId: "cn-hongkong", Traffic: 1024, ISPType: "BGP" },
        ],
      },
    };
  };
  const usage = await g.usage("a", "cn-hongkong", ["i-test"]);
  assert.equal(cdtAction, "ListCdtInternetTraffic");
  assert.equal(usage[0].trafficUsed, 1024);
});
