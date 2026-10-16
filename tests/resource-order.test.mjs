import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { sortByName } from "../shared/resource-order.ts";
import {
  cycleDetails,
  dailySummary,
  formatNotification,
} from "../shared/notifications.ts";
import { Store } from "../server/store.mjs";
import { ResourceService } from "../server/service.mjs";

test("名称使用自然升序，同名项以稳定标识排序且不修改输入", () => {
  const rows = [
    { name: "CDT10", id: "10" },
    { name: "cdt2", id: "2" },
    { name: "CDT1", id: "1", accountId: "b" },
    { name: "CDT1", id: "1", accountId: "a" },
  ];
  const original = structuredClone(rows);
  const ordered = sortByName(rows);
  assert.deepEqual(
    ordered.map((r) => r.name),
    ["CDT1", "CDT1", "cdt2", "CDT10"],
  );
  assert.deepEqual(
    ordered.slice(0, 2).map((r) => r.accountId),
    ["a", "b"],
  );
  assert.deepEqual(sortByName([...rows].reverse()), ordered);
  assert.deepEqual(rows, original);
  const duplicates = [
    { name: "相同名称", region: "cn-hongkong", id: "b" },
    { name: "相同名称", region: "cn-hangzhou", id: "z" },
    { name: "相同名称", region: "cn-hongkong", id: "a" },
  ];
  assert.deepEqual(
    sortByName(duplicates).map((r) => r.id),
    ["z", "a", "b"],
  );
});

test("不同账号和地域的快照乱序刷新、更新与重新打开后实例顺序不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-order-"));
  let store;
  try {
    store = new Store(dir);
    for (const [id, name] of [
      ["a", "账号2"],
      ["b", "账号1"],
    ])
      store.saveAccount(
        { name, site: "international" },
        { accessKeyId: "fixture", accessKeySecret: "fixture" },
        id,
      );
    const scopes = [
      {
        accountId: "a",
        region: "cn-hongkong",
        at: 1,
        items: [
          { id: "i-10", name: "CDT10" },
          { id: "i-1", name: "CDT1" },
        ],
      },
      {
        accountId: "b",
        region: "ap-southeast-1",
        at: 1,
        items: [{ id: "i-2", name: "CDT2" }],
      },
    ].map((s) => ({
      ...s,
      items: s.items.map((i) => ({
        ...i,
        accountId: s.accountId,
        region: s.region,
        status: "Running",
      })),
    }));
    const save = (s) =>
      store.put("scope", JSON.stringify([s.accountId, s.region]), s);
    scopes.forEach(save);
    const names = () =>
      new ResourceService(store, {}).instances().items.map((i) => i.name);
    const expected = ["CDT1", "CDT2", "CDT10"];
    assert.deepEqual(names(), expected);
    const rowids = () =>
      store.db
        .prepare(
          "SELECT id, rowid FROM entities WHERE kind='scope' ORDER BY id",
        )
        .all();
    const before = rowids();
    for (const s of [...scopes].reverse())
      save({ ...s, at: 2, items: [...s.items].reverse() });
    assert.deepEqual(rowids(), before);
    assert.deepEqual(names(), expected);
    assert.deepEqual(
      store.accounts().map((a) => a.name),
      ["账号1", "账号2"],
    );
    store.close();
    store = new Store(dir);
    assert.deepEqual(names(), expected);
  } finally {
    store?.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + "aliyun-order-"),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("通知汇总按名称升序截取，每台实例与总览之间空一行，异常仍归属原实例", () => {
  const items = [10, 2, 1, 6, 3, 4].map((n) => ({
    name: `CDT${n}`,
    id: `i-${n}`,
    region: "cn-hongkong",
    status: "Running",
    usage: { used: n * 1024 ** 3, total: 200 * 1024 ** 3 },
    billing: { amount: 0.36, currency: "USD" },
    ...(n === 2 ? { error: "fixture-error" } : {}),
  }));
  for (const render of [cycleDetails, (rows) => dailySummary(rows, [])]) {
    const message = render(items);
    assert.equal(message, render([...items].reverse()));
    const blocks = message.split("\n\n");
    assert.match(blocks[0], /^6 台/);
    assert.deepEqual(
      blocks.slice(1, 6).map((b) => b.match(/CDT\d+/)[0]),
      ["CDT1", "CDT2", "CDT3", "CDT4", "CDT6"],
    );
    assert.match(blocks[6], /其余 1 台/);
    assert.ok(!message.includes("\n\n\n"));
    const formatted = formatNotification(
      {
        title: "汇总",
        kind: render === cycleDetails ? "cycle" : "report",
        message,
      },
      true,
    );
    assert.ok(formatted.includes("\n\n🇭🇰 CDT2"));
  }
  assert.match(
    cycleDetails(items).split("\n\n")[2],
    /CDT2[^]*\n异常：fixture-error$/,
  );
});
