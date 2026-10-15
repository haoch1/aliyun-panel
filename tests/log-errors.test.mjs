import test from "node:test";
import assert from "node:assert/strict";
import {
  logErrorText,
  resourceLogSummary,
} from "../shared/log-presentation.ts";

const legacyDns = (host) =>
  `getaddrinfo ENOTFOUND ${host}POST https://${host}/?InstanceIds=i-example failed.`;

test("旧 SDK 网络错误以简明原因和错误码展示，不铺开请求地址", () => {
  for (const host of [
    "ecs.cn-hongkong.aliyuncs.com",
    "vpc.cn-hongkong.aliyuncs.com",
    "business.ap-southeast-1.aliyuncs.com",
  ]) {
    const raw = legacyDns(host);
    assert.equal(logErrorText(raw), "接口域名解析失败（ENOTFOUND）");
    assert.equal(resourceLogSummary({ error: raw }).error, logErrorText(raw));
    assert.equal(
      resourceLogSummary({ usage: { error: raw } }).error,
      logErrorText(raw),
    );
    assert.equal(
      resourceLogSummary({ billing: { error: raw } }).error,
      logErrorText(raw),
    );
  }
});

test("重复 DNS 错误合并展示，保留余额和账单查询失败的归属", () => {
  const raw = `余额：${legacyDns("business.example")}；账单：${legacyDns("business.example")}`;
  assert.equal(
    logErrorText(raw),
    "余额、账单查询失败：接口域名解析失败（ENOTFOUND）",
  );
});

test("不同网络错误分别展示，权限错误和正常日志不被改写", () => {
  assert.equal(
    logErrorText("connect ETIMEDOUT host"),
    "接口连接超时（ETIMEDOUT）",
  );
  assert.equal(logErrorText("ECONNRESET"), "接口连接中断（ECONNRESET）");
  assert.equal(logErrorText("ECONNREFUSED"), "接口连接被拒绝（ECONNREFUSED）");
  assert.equal(logErrorText("ENETUNREACH"), "接口网络不可达（ENETUNREACH）");
  assert.equal(
    logErrorText("Forbidden.RAM: Access denied"),
    "Forbidden.RAM: Access denied",
  );
  assert.equal(logErrorText("账单与余额查询完成"), "账单与余额查询完成");
  assert.equal(logErrorText(undefined), "");
});

test("格式化历史失败记录不更改错误原文、状态或时间", () => {
  const entry = {
    at: "2026-10-15T10:33:32.943Z",
    status: "failed",
    error: legacyDns("ecs.example"),
  };
  const original = structuredClone(entry);
  resourceLogSummary(entry);
  logErrorText(entry.error);
  assert.deepEqual(entry, original);
});
