import test from "node:test";
import assert from "node:assert/strict";
import { createResourceCache } from "../src/resource-cache.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("列表与弹窗订阅同一缓存，成功刷新同步通知，失败和迟到响应不发布新值", async () => {
  const cache = createResourceCache();
  const values = [];
  const unsubscribe = cache.subscribe("traffic", () =>
    values.push(cache.get("traffic")),
  );
  const old = deferred();
  const pending = cache.request("traffic", () => old.promise, 0);
  await cache.request("traffic", async () => 220, 1);
  old.resolve(100);
  await pending;
  assert.deepEqual(values, [220]);
  await assert.rejects(
    cache.request("traffic", async () => {
      throw Error("offline");
    }),
  );
  assert.deepEqual(values, [220]);
  await cache.request("other-range", async () => 400);
  assert.deepEqual(values, [220]);
  cache.clear();
  assert.deepEqual(values, [220, undefined]);
  unsubscribe();
  await cache.request("traffic", async () => 300);
  assert.deepEqual(values, [220, undefined]);
});

test("同一页面的并发读取合并，后台刷新保留已有数据", async () => {
  const cache = createResourceCache();
  const first = deferred();
  let calls = 0;
  const load = () => {
    calls++;
    return first.promise;
  };
  const a = cache.request("real:/audit", load);
  const b = cache.request("real:/audit", load);
  assert.equal(a, b);
  await Promise.resolve();
  assert.equal(calls, 1);
  first.resolve({ items: [1] });
  await a;
  assert.deepEqual(cache.get("real:/audit"), { items: [1] });
  const next = deferred();
  const refresh = cache.request("real:/audit", () => next.promise);
  assert.deepEqual(cache.get("real:/audit"), { items: [1] });
  next.resolve({ items: [1, 2] });
  await refresh;
  assert.deepEqual(cache.get("real:/audit"), { items: [1, 2] });
});

test("查询失败保留上次成功结果，并允许后续重新请求", async () => {
  const cache = createResourceCache();
  await cache.request("real:/billing", async () => ({ balance: 12 }));
  await assert.rejects(
    cache.request("real:/billing", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.deepEqual(cache.get("real:/billing"), { balance: 12 });
  await cache.request("real:/billing", async () => ({ balance: 13 }));
  assert.deepEqual(cache.get("real:/billing"), { balance: 13 });
});

test("保存后刷新不复用保存前的慢请求，迟到的旧响应不会覆盖新结果", async () => {
  const cache = createResourceCache();
  const old = deferred(),
    saved = deferred();
  const oldRequest = cache.request("real:/settings", () => old.promise, 0);
  const newRequest = cache.request("real:/settings", () => saved.promise, 1);
  assert.notEqual(oldRequest, newRequest);
  saved.resolve({ saved: true });
  await newRequest;
  old.resolve({ saved: false });
  await oldRequest;
  assert.deepEqual(cache.get("real:/settings"), { saved: true });
});

test("退出或切换登录后清除数据，旧会话响应不能污染新会话或删除新请求", async () => {
  const cache = createResourceCache();
  await cache.request("real:/settings", async () => ({ owner: "old" }));
  const old = deferred(),
    current = deferred();
  const oldRequest = cache.request("real:/audit", () => old.promise);
  const epoch = cache.version;
  cache.clear();
  assert.equal(cache.version, epoch + 1);
  assert.equal(cache.get("real:/settings"), undefined);
  const currentRequest = cache.request("real:/audit", () => current.promise);
  old.resolve({ owner: "old" });
  await oldRequest;
  assert.equal(cache.get("real:/audit"), undefined);
  assert.equal(
    cache.request("real:/audit", async () => ({ owner: "unexpected" })),
    currentRequest,
  );
  current.resolve({ owner: "current" });
  await currentRequest;
  assert.deepEqual(cache.get("real:/audit"), { owner: "current" });
});

test("演示与真实数据、实例、日期范围分别缓存，超过容量淘汰旧条目", async () => {
  const cache = createResourceCache(3);
  const keys = [
    "real:/traffic?id=a&days=month",
    "real:/traffic?id=a&days=7",
    "real:/traffic?id=b&days=month",
  ];
  await Promise.all(keys.map((key, n) => cache.request(key, async () => n)));
  keys.forEach((key, n) => assert.equal(cache.get(key), n));
  assert.equal(cache.get("demo:/traffic?id=a&days=month"), undefined);
  await cache.request("demo:/traffic?id=a&days=month", async () => 10);
  assert.equal(cache.get(keys[0]), undefined);
  assert.equal(cache.get(keys[1]), 1);
  assert.equal(cache.get("demo:/traffic?id=a&days=month"), 10);
});
