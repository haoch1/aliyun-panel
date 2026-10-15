import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fixture } from "./fixture.mjs";

const template = readFileSync(
  new URL("../docs/ram-ecs-policy.template.json", import.meta.url),
  "utf8",
);
const target = {
  accountId: "account-test",
  region: "cn-hongkong",
  id: "i-web",
};
const policy = JSON.parse(
  template
    .replaceAll("<REGION_ID>", target.region)
    .replaceAll("<ACCOUNT_ID>", "fixture-owner")
    .replaceAll("<INSTANCE_ID>", target.id),
);
const array = (value) => (Array.isArray(value) ? value : [value]);
// Evaluate only this template's exact Allow actions/resources, not the full RAM language.
function allowed(action, resource) {
  return policy.Statement.some(
    (statement) =>
      statement.Effect === "Allow" &&
      array(statement.Action).includes(action) &&
      array(statement.Resource).some((r) => r === "*" || r === resource),
  );
}
function runtime(t) {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-ram-test-"));
  const r = fixture(dir);
  t.after(() => {
    r.store.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + "aliyun-ram-test-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const rpc = r.gateway.rpc;
  r.gateway.rpc = async (account, region, action, params, options) => {
    if (options.product === "ecs" && action !== "DescribeRegions") {
      const arn = `acs:ecs:${region}:fixture-owner:instance/${params.instanceId || "*"}`;
      assert.ok(
        allowed("ecs:" + action, arn),
        `Policy denied ${action} on ${arn}`,
      );
    } else {
      assert.ok(
        new Set([
          "sts:GetCallerIdentity",
          "ecs:DescribeRegions",
          "cdt:ListCdtInternetTraffic",
          "bss:QueryAccountBalance",
          "bss:DescribeInstanceBill",
          "vpc:DescribeEipMonitorData",
        ]).has(options.product + ":" + action),
        `Unexpected cloud API ${options.product}:${action}`,
      );
      assert.equal(options.write, false);
    }
    return rpc(account, region, action, params, options);
  };
  return r;
}

test("受限 ECS 策略仅含四项明确操作，写入和监控仅限指定实例", () => {
  assert.equal(policy.Version, "1");
  assert.deepEqual(policy.Statement.flatMap((s) => array(s.Action)).sort(), [
    "ecs:DescribeInstanceMonitorData",
    "ecs:DescribeInstances",
    "ecs:StartInstance",
    "ecs:StopInstance",
  ]);
  const arn = `acs:ecs:${target.region}:fixture-owner:instance/${target.id}`;
  for (const action of [
    "StartInstance",
    "StopInstance",
    "DescribeInstanceMonitorData",
  ]) {
    assert.equal(allowed("ecs:" + action, arn), true);
    assert.equal(
      allowed("ecs:" + action, arn.replace(target.id, "i-other")),
      false,
    );
    assert.equal(
      allowed("ecs:" + action, arn.replace(target.region, "cn-hangzhou")),
      false,
    );
    assert.equal(
      allowed("ecs:" + action, arn.replace("fixture-owner", "other-owner")),
      false,
    );
  }
  for (const action of [
    "RunInstances",
    "CreateInstance",
    "DeleteInstance",
    "RenewInstance",
    "ModifyInstanceSpec",
    "CreateSnapshot",
    "CreateDisk",
    "AuthorizeSecurityGroup",
    "RunCommand",
    "AttachInstanceRamRole",
  ])
    assert.equal(allowed("ecs:" + action, arn), false, action);
  assert.equal(allowed("ecs:DescribeInstances", "*"), true);
});

test("添加查询、状态核实、两种图表、月度流量和账单覆盖受限策略", async (t) => {
  const r = runtime(t);
  await r.gateway.identity({
    site: "international",
    accessKeyId: "fixture-key",
    accessKeySecret: "fixture-secret",
  });
  await r.gateway.regions(target.accountId);
  assert.equal((await r.gateway.instance(target)).id, target.id);
  assert.equal(await r.gateway.status(target), "Running");
  const end = Math.floor(Date.now() / 3600000) * 3600000;
  await r.gateway.monitor(target, "INTERNET_OUT", end - 3600000, end);
  await r.gateway.monitor(
    { ...target, publicNetwork: "eip", eipAllocationId: "eip-fixture" },
    "INTERNET_OUT",
    end - 3600000,
    end,
  );
  await r.gateway.usage(target.accountId, target.region, [target.id]);
  await r.gateway.billing(
    target.accountId,
    target.region,
    [target.id],
    "2026-10",
  );
  assert.ok(r.calls.every((c) => !c.options.write));
});

test("保活、流量关机与定时开关机所用的控制接口均被受限策略覆盖", async (t) => {
  const r = runtime(t);
  for (const stoppedMode of ["KeepCharging", "StopCharging"]) {
    await r.gateway.control(target, "stop", "fixture-stop", { stoppedMode });
    assert.equal(r.state.get(target.id), "Stopped");
    assert.equal(await r.gateway.status(target), "Stopped");
    await r.gateway.control(target, "start", "fixture-start");
    assert.equal(r.state.get(target.id), "Running");
    assert.equal(await r.gateway.status(target), "Running");
  }
  await assert.rejects(
    r.gateway.control({ ...target, id: "i-other" }, "stop", "fixture-denied"),
    /Policy denied StopInstance/,
  );
});
