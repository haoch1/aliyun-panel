import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fixture } from "./fixture.mjs";
import { ResourceService } from "../server/service.mjs";
import { billingCycle } from "../server/billing.mjs";
import { AliyunGateway } from "../server/aliyun.mjs";
import { resourceKey } from "../server/store.mjs";

const target = {
  accountId: "account-test",
  region: "cn-hongkong",
  id: "i-web",
};
function runtime(t) {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-15T06:30:00Z"),
  });
  const dir = mkdtempSync(join(tmpdir(), "aliyun-traffic-test-"));
  const r = fixture(dir);
  t.after(() => {
    r.store.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + "aliyun-traffic-test-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  return r;
}
const monitorCalls = (r) =>
  r.calls.filter((c) => c.action === "DescribeInstanceMonitorData");

test("每日图表使用官方时间格式，30 天最多两次查询，入出流量共用响应", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const [a, b] = await Promise.all([
    r.service.traffic(target, 30),
    r.service.traffic(target, 30),
  ]);
  assert.equal(a.errors.length, 0);
  assert.deepEqual(a.items, b.items);
  assert.equal(monitorCalls(r).length, 2);
  assert.ok(a.items.length >= 29);
  for (const call of monitorCalls(r)) {
    assert.match(call.params.startTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(
      (Date.parse(call.params.endTime) - Date.parse(call.params.startTime)) /
        3600000 <=
        400,
    );
  }
  assert.ok(r.calls.every((c) => !c.options.write));
});

test("切换范围和重开页面复用历史，服务重建不全量重拉，只补最新小时", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  await r.service.traffic(target, 30);
  const count = monitorCalls(r).length;
  await r.service.traffic(target, "month");
  const freshService = new ResourceService(r.store, r.gateway);
  await freshService.traffic(target, 7);
  assert.equal(monitorCalls(r).length, count);
  t.mock.timers.setTime(Date.parse("2026-10-15T07:30:00Z"));
  await freshService.traffic(target, "month");
  assert.equal(monitorCalls(r).length, count + 1);
  const last = monitorCalls(r).at(-1).params;
  assert.equal(last.startTime, "2026-10-15T04:00:00Z");
  assert.equal(last.endTime, "2026-10-15T07:00:00Z");
});

test("每日图表失败保留旧数据、只提示一次并冷却五分钟，不干扰状态和月度流量检测", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const first = await r.service.traffic(target, "month");
  t.mock.timers.setTime(Date.parse("2026-10-15T06:36:00Z"));
  const rpc = r.gateway.rpc;
  let failures = 0;
  r.gateway.rpc = async (...args) => {
    if (args[2] === "DescribeInstanceMonitorData") {
      failures++;
      throw new Error("Forbidden: monitor access denied");
    }
    return rpc(...args);
  };
  const failed = await r.service.traffic(target, "month");
  assert.deepEqual(failed.items, first.items);
  assert.equal(failed.errors.length, 1);
  assert.equal(failures, 1);
  await r.service.traffic(target, "month");
  await new ResourceService(r.store, r.gateway).traffic(target, 7);
  assert.equal(failures, 1);
  assert.equal(
    r.store.logs().filter((l) => l.action === "traffic-query").length,
    1,
  );
  await r.service.statusCycle();
  assert.equal(r.service.instance(target).status, "Running");
  assert.equal(r.service.instance(target).usage.error, undefined);
  t.mock.timers.setTime(Date.parse("2026-10-15T06:42:00Z"));
  await r.service.traffic(target, "month");
  assert.equal(failures, 2);
});

test("DNS 失败保留真实历史，一分钟内合并失败请求，恢复后清除错误", async (t) => {
  const r = runtime(t);
  useEip(r);
  await r.service.refresh();
  const first = await r.service.traffic(target, "month");
  const rpc = r.gateway.rpc;
  let failures = 0;
  r.gateway.rpc = async (...args) => {
    if (args[2] === "DescribeEipMonitorData") {
      failures++;
      throw Object.assign(
        new Error(
          "getaddrinfo ENOTFOUND vpc.examplePOST https://vpc.example/?AllocationId=private failed.",
        ),
        { code: "ENOTFOUND" },
      );
    }
    return rpc(...args);
  };
  t.mock.timers.setTime(Date.now() + 360000);
  const failed = await r.service.traffic(target, "month");
  assert.deepEqual(failed.items, first.items);
  assert.match(failed.errors[0], /域名暂时无法解析/);
  assert.match(failed.errors[0], /已保留上次流量数据/);
  assert.doesNotMatch(failed.errors[0], /https:|AllocationId/);
  assert.equal(
    r.store.get("traffic-sync", resourceKey(target)).retryAt,
    Date.now() + 60000,
  );
  await new ResourceService(r.store, r.gateway).traffic(target, 7);
  assert.equal(failures, 1);
  t.mock.timers.setTime(Date.now() + 61000);
  r.gateway.rpc = rpc;
  const recovered = await r.service.traffic(target, "month");
  assert.deepEqual(recovered.errors, []);
  assert.deepEqual(recovered.items, first.items);
  assert.equal(
    r.store.get("traffic-sync", resourceKey(target)).error,
    undefined,
  );
  assert.ok(r.calls.every((c) => !c.options.write));
});

test("旧版缓存中的 DNS 原始报错也转换为简洁提示，不永久保留错误状态", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const first = await r.service.traffic(target, "month");
  const key = resourceKey(target);
  r.store.put("traffic-sync", key, {
    ...r.store.get("traffic-sync", key),
    error:
      "getaddrinfo ENOTFOUND vpc.examplePOST https://vpc.example/?AllocationId=private failed.",
    retryAt: Date.now() + 60000,
  });
  const cached = await r.service.traffic(target, "month");
  assert.match(cached.errors[0], /域名暂时无法解析/);
  assert.doesNotMatch(cached.errors[0], /https:|AllocationId/);
  t.mock.timers.setTime(Date.now() + 61000);
  const recovered = await new ResourceService(r.store, r.gateway).traffic(
    target,
    "month",
  );
  assert.deepEqual(recovered.errors, []);
  assert.deepEqual(recovered.items, first.items);
});

test("已接入实例的后台发现只查询明确指定 ID，不枚举同地域其他服务器", async (t) => {
  const r = runtime(t);
  const account = r.store.account(target.accountId);
  const { credentials, ...meta } = account;
  r.store.saveAccount(
    {
      ...meta,
      monitors: [{ id: target.id, region: target.region, name: "web" }],
    },
    credentials,
    account.id,
  );
  await r.service.refresh();
  const calls = r.calls.filter((c) => c.action === "DescribeInstances");
  assert.ok(calls.length);
  assert.ok(calls.every((c) => c.params.instanceIds === '["i-web"]'));
});

test("账单站点不匹配给出正确提示，不假报权限缺失且不会遍历另一个站点", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const rpc = r.gateway.rpc;
  const endpoints = [];
  r.gateway.rpc = async (...args) => {
    if (args[4].product === "bss") {
      endpoints.push(args[1]);
      throw new Error(
        args[2] === "QueryAccountBalance"
          ? "AuthSiteFail: auth site failed"
          : "NotApplicable: Please check whether the caller site matches the API domain regionId",
      );
    }
    return rpc(...args);
  };
  const result = await r.engine.billing.refresh({
    force: true,
    cycle: billingCycle(),
  });
  assert.match(result.items[0].error, /账号所属站点与账单接口不匹配/);
  assert.ok(endpoints.every((region) => region === "cn-hangzhou"));
  await r.engine.cycle(true);
  const cycle = r.store.logs().find((l) => l.action === "monitor-cycle");
  assert.equal(cycle.status, "success");
  assert.match(cycle.detail, /异常 0/);
  const instance = cycle.context.resources.find((i) => i.id === target.id);
  assert.equal(instance.error, undefined);
  assert.match(instance.billing.error, /账号所属站点与账单接口不匹配/);
  assert.equal(r.service.instance(target).status, "Running");
});

function useEip(r, id = "eip-test") {
  const rpc = r.gateway.rpc;
  r.gateway.rpc = async (...args) => {
    const body = await rpc(...args);
    if (args[2] === "DescribeInstances")
      for (const i of body.instances.instance)
        if (i.instanceId === target.id) {
          i.publicIpAddress = { ipAddress: [] };
          i.eipAddress = { allocationId: id, ipAddress: "192.0.2.20" };
        }
    return body;
  };
}
test("EIP 自动选择 VPC 监控，字节不再转换为 Kbit，30 天最多四次且入出共用", async (t) => {
  const r = runtime(t);
  useEip(r);
  await r.service.refresh();
  assert.equal(r.service.instance(target).eipAllocationId, "eip-test");
  assert.equal(r.service.instance(target).publicNetwork, "eip");
  const data = await r.service.traffic(target, 30);
  assert.deepEqual(data.errors, []);
  const calls = r.calls.filter((c) => c.action === "DescribeEipMonitorData");
  assert.equal(calls.length, 4);
  assert.equal(monitorCalls(r).length, 0);
  assert.ok(
    calls.every(
      (c) =>
        c.params.allocationId === "eip-test" &&
        c.options.product === "vpc" &&
        !c.options.write,
    ),
  );
  assert.equal(
    data.items.reduce((sum, d) => sum + d.outBytes, 0),
    710 * 8192,
  );
  assert.equal(
    data.items.reduce((sum, d) => sum + d.inBytes, 0),
    710 * 4096,
  );
  await new ResourceService(r.store, r.gateway).traffic(target, 7);
  assert.equal(
    r.calls.filter((c) => c.action === "DescribeEipMonitorData").length,
    4,
  );
});
test("切换到 EIP 或更换 EIP 不复用旧来源历史，权限失败不会回退到 ECS 零值", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  await r.service.traffic(target, "month");
  useEip(r);
  await r.service.refresh();
  const eip = await r.service.traffic(target, "month");
  assert.ok(eip.items.length);
  const rpc = r.gateway.rpc;
  let denied = 0;
  r.gateway.rpc = async (...args) => {
    if (args[2] === "DescribeEipMonitorData") {
      denied++;
      throw Object.assign(new Error("Forbidden.RAM: User not authorized"), {
        code: "Forbidden.RAM",
      });
    }
    return rpc(...args);
  };
  const before = monitorCalls(r).length;
  useEip(r, "eip-rebound");
  await r.service.refresh();
  const failed = await r.service.traffic(target, "month");
  assert.equal(failed.items.length, 0);
  assert.match(failed.errors[0], /vpc:DescribeEipMonitorData/);
  await new ResourceService(r.store, r.gateway).traffic(target, "month");
  assert.equal(denied, 1);
  assert.equal(monitorCalls(r).length, before);
  assert.equal(
    r.store.logs().find((l) => l.action === "traffic-query").context.api,
    "DescribeEipMonitorData",
  );
});
test("EIP 缺少 AllocationId 时不发云请求，缺少监控值不补零", async (t) => {
  const r = runtime(t);
  await assert.rejects(
    r.gateway.monitor(
      { ...target, publicNetwork: "eip" },
      "INTERNET_OUT",
      0,
      3600000,
    ),
    /EIP 标识/,
  );
  assert.equal(r.calls.length, 0);
  r.gateway.rpc = async () => ({
    eipMonitorDatas: {
      eipMonitorData: [{ timeStamp: "2026-10-15T06:00:00Z", eipRX: 0 }],
    },
  });
  const out = await r.gateway.monitor(
    { ...target, eipAllocationId: "eip-test" },
    "INTERNET_OUT",
    Date.parse("2026-10-15T05:00:00Z"),
    Date.parse("2026-10-15T06:00:00Z"),
  );
  assert.equal(out[0].value, undefined);
});
test("旧版数据库没有公网类型时先同步元数据，不沿用旧图表缓存", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const scopeKey = JSON.stringify([target.accountId, target.region]);
  const scope = r.store.get("scope", scopeKey);
  delete scope.items.find((i) => i.id === target.id).publicNetwork;
  r.store.put("scope", scopeKey, scope);
  const end = Date.parse("2026-10-15T06:00:00Z");
  r.store.put("traffic-sync", resourceKey(target), {
    ...target,
    start: end - 30 * 86400000,
    end,
    checkedAt: Date.now(),
  });
  useEip(r);
  const data = await r.service.traffic(target, 7);
  assert.deepEqual(data.errors, []);
  assert.equal(r.service.instance(target).publicNetwork, "eip");
  assert.equal(monitorCalls(r).length, 0);
  assert.ok(r.calls.some((c) => c.action === "DescribeEipMonitorData"));
});
test("真实 VPC SDK 的参数和响应模型读取 EIP 字节，离线测试不访问网络", async () => {
  const account = {
    id: "a",
    site: "international",
    credentials: { accessKeyId: "fixture", accessKeySecret: "fixture" },
  };
  const gateway = new AliyunGateway({ account: () => account });
  const client = gateway.client("vpc", account, "cn-hongkong");
  assert.equal(client._endpoint, "vpc.cn-hongkong.aliyuncs.com");
  client.callApi = async (p, req) => {
    assert.equal(p.action, "DescribeEipMonitorData");
    assert.equal(req.query.AllocationId, "eip-test");
    assert.equal(req.query.RegionId, "cn-hongkong");
    return {
      body: {
        EipMonitorDatas: {
          EipMonitorData: [
            { TimeStamp: req.query.EndTime, EipRX: 1234, EipTX: 5678 },
          ],
        },
      },
    };
  };
  const end = Math.floor(Date.now() / 3600000) * 3600000;
  const points = await gateway.monitor(
    {
      accountId: "a",
      region: "cn-hongkong",
      id: "i-web",
      eipAllocationId: "eip-test",
    },
    "INTERNET_OUT",
    end - 3600000,
    end,
  );
  assert.equal(points[0].value, 5678);
});
