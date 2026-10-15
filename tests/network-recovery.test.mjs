import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import {
  AliyunGateway,
  errorText,
  networkErrorCode,
} from "../server/aliyun.mjs";

const account = {
  id: "test-network",
  site: "international",
  credentials: { accessKeyId: "fixture-id", accessKeySecret: "fixture-secret" },
};
const target = { accountId: account.id, region: "cn-hongkong", id: "i-test" };

async function localSdk(t, product, handle) {
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const gateway = new AliyunGateway({ account: () => account });
  const client = gateway.client(product, account, target.region);
  assert.equal(client._retryOptions.retryable, false);
  // Exercise the real SDK transport with fake credentials, only against loopback.
  client._endpoint = "127.0.0.1:" + server.address().port;
  client._protocol = "HTTP";
  return gateway;
}

test("真实 SDK 只读网络中断最多尝试三次，恢复后返回数据", async (t) => {
  let calls = 0;
  const gateway = await localSdk(t, "vpc", (req, res) => {
    calls++;
    assert.equal(req.headers["x-acs-action"], "DescribeEipMonitorData");
    if (calls < 3) return req.socket.destroy();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ EipMonitorDatas: { EipMonitorData: [] } }));
  });
  const body = await gateway.call(
    account.id,
    target.region,
    "DescribeEipMonitorData",
    { regionId: target.region, allocationId: "eip-test" },
    { product: "vpc" },
  );
  assert.equal(calls, 3);
  assert.deepEqual(body.eipMonitorDatas.eipMonitorData, []);
});

test("真实 SDK 开关机网络中断只发一次，避免重复控制", async (t) => {
  let calls = 0;
  const gateway = await localSdk(t, "ecs", (req) => {
    calls++;
    assert.equal(req.headers["x-acs-action"], "StopInstance");
    req.socket.destroy();
  });
  await assert.rejects(gateway.control(target, "stop"), (e) => {
    assert.equal(e.code, "ECONNRESET");
    assert.match(e.message, /连接暂时中断/);
    return true;
  });
  assert.equal(calls, 1);
});

test("真实 SDK 权限拒绝不重试", async (t) => {
  let calls = 0;
  const gateway = await localSdk(t, "vpc", (_req, res) => {
    calls++;
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ Code: "Forbidden.RAM", Message: "Not authorized" }),
    );
  });
  await assert.rejects(
    gateway.call(
      account.id,
      target.region,
      "DescribeEipMonitorData",
      {},
      {
        product: "vpc",
      },
    ),
    (e) => e.code === "Forbidden.RAM",
  );
  assert.equal(calls, 1);
});

test("DNS 持续失败只尝试三次，错误保留分类而不暴露 SDK 请求地址", async () => {
  const gateway = new AliyunGateway({ account: () => account });
  const client = gateway.client("vpc", account, target.region);
  let calls = 0;
  client.describeEipMonitorDataWithOptions = async () => {
    calls++;
    throw Object.assign(
      new Error(
        "getaddrinfo ENOTFOUND vpc.cn-hongkong.aliyuncs.comPOST https://vpc.cn-hongkong.aliyuncs.com/?AllocationId=eip-private failed.",
      ),
      { code: "ENOTFOUND" },
    );
  };
  await assert.rejects(
    gateway.call(
      account.id,
      target.region,
      "DescribeEipMonitorData",
      {},
      {
        product: "vpc",
      },
    ),
    (e) => {
      assert.equal(e.code, "ENOTFOUND");
      assert.equal(e.message, "阿里云接口域名暂时无法解析，请稍后重试");
      assert.doesNotMatch(e.message, /https:|AllocationId|eip-private/);
      return true;
    },
  );
  assert.equal(calls, 3);
  assert.equal(
    errorText({
      cause: Object.assign(new Error("DNS"), { code: "EAI_AGAIN" }),
    }),
    "阿里云接口域名暂时无法解析，请稍后重试",
  );
});

test("真实 HTTP 超时沿 cause 识别，Telegram 与阿里云提示各自来源，主动取消不误判", async (t) => {
  const server = createServer((_req, _res) => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const error = await new Promise((resolve) => {
    const req = request({
      hostname: "127.0.0.1",
      port: server.address().port,
      signal: AbortSignal.timeout(30),
    });
    req.on("error", resolve);
    req.end();
  });
  assert.equal(error.name, "AbortError");
  assert.equal(error.cause.name, "TimeoutError");
  assert.equal(networkErrorCode(error), "ETIMEDOUT");
  assert.equal(errorText(error), "阿里云接口连接超时，请稍后重试");
  assert.equal(
    errorText(error, [], "Telegram"),
    "Telegram 接口连接超时，请稍后重试",
  );
  assert.equal(
    errorText({ code: "ENOTFOUND" }, [], "Telegram"),
    "Telegram 接口域名暂时无法解析，请稍后重试",
  );
  assert.equal(
    networkErrorCode(new DOMException("主动取消", "AbortError")),
    undefined,
  );
});
