import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fixture } from "./fixture.mjs";
import { Store, resourceKey } from "../server/store.mjs";
import { ResourceService } from "../server/service.mjs";
import { trafficMetric } from "../server/aliyun.mjs";
import { singleDirectionTraffic } from "../shared/traffic-presentation.ts";

const MINUTE = 60000,
  HOUR = 3600000;
const base = Date.parse("2026-10-01T00:00:00+08:00");
const target = {
  accountId: "account-test",
  region: "cn-hongkong",
  id: "i-web",
};
const other = { ...target, id: "i-data" };
function runtime(t, at = base) {
  t.mock.timers.enable({ apis: ["Date"], now: at });
  const dir = mkdtempSync(join(tmpdir(), "aliyun-binding-test-"));
  const r = fixture(dir);
  r.bindings = new Map([[target.id, "eip-0"]]);
  const rpc = r.gateway.rpc;
  r.gateway.rpc = async (...args) => {
    const b = await rpc(...args);
    if (args[2] === "DescribeInstances")
      for (const i of b.instances.instance) {
        const eip = r.bindings.get(i.instanceId);
        if (eip) {
          i.eipAddress = { allocationId: eip, ipAddress: "192.0.2.21" };
          i.publicIpAddress = { ipAddress: [] };
        }
      }
    return b;
  };
  r.monitorCalls = [];
  r.gateway.monitor = async (t, metric, start, end, period) => {
    r.monitorCalls.push({ t, metric, start, end, period });
    const rate = metric === "INTERNET_IN" ? 10 : 20;
    const points = [];
    for (let at = start + period * 1000; at <= end; at += period * 1000)
      points.push({ timestamp: at, value: (rate * period) / 60 });
    return points;
  };
  t.after(async () => {
    if (r.service.capturing) await r.service.capturing;
    r.store.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + "aliyun-binding-test-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  r.advance = (minutes) => t.mock.timers.setTime(Date.now() + minutes * MINUTE);
  return { ...r, dir };
}
const totals = (d) => d.items.reduce((n, r) => n + (r.outBytes ?? 0), 0);

test("同一实例连续换十个 EIP 后按绑定期间累计，重查、切回旧 EIP 和服务重建不重复", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  for (let n = 1; n < 10; n++) {
    r.advance(6);
    r.bindings.set(target.id, "eip-" + n);
    await r.service.refresh();
    assert.equal(totals(await r.service.traffic(target, "month")), n * 6 * 20);
  }
  r.advance(6);
  const first = await r.service.traffic(target, "month");
  assert.equal(totals(first), 60 * 20);
  assert.equal(singleDirectionTraffic(first.items), 60 * 20);
  assert.equal(totals(await r.service.traffic(target, "month")), 60 * 20);
  const restarted = new ResourceService(r.store, r.gateway);
  assert.equal(totals(await restarted.traffic(target, "month")), 60 * 20);
  r.bindings.set(target.id, "eip-0");
  await r.service.refresh();
  r.advance(6);
  assert.equal(totals(await r.service.traffic(target, "month")), 66 * 20);
  assert.equal(r.service.history.bindings(target).length, 11);
});

test("同一 EIP 转绑其他实例后，分别只统计各自的绑定时段", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.advance(10);
  assert.equal(totals(await r.service.traffic(target, "month")), 200);
  r.bindings.set(target.id, "eip-new");
  r.bindings.set(other.id, "eip-0");
  await r.service.refresh();
  r.advance(5);
  assert.equal(totals(await r.service.traffic(target, "month")), 300);
  assert.equal(totals(await r.service.traffic(other, "month")), 100);
  const stale = {
    ...r.service.instance(target),
    eipAllocationId: "eip-0",
    statusAt: base + 9 * MINUTE,
  };
  r.service.history.observe(stale, stale.statusAt);
  r.advance(5);
  assert.equal(totals(await r.service.traffic(other, "month")), 200);
  assert.equal(totals(await r.service.traffic(target, "month")), 400);
});

test("分钟尾部被完整小时替换后只计一次，并压缩已覆盖分钟明细", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.advance(30);
  assert.equal(totals(await r.service.traffic(target, "month")), 600);
  r.advance(30);
  assert.equal(totals(await r.service.traffic(target, "month")), 1200);
  const b = r.service.history.bindings(target)[0];
  assert.equal(
    r.store.db
      .prepare(
        "SELECT count(*) AS n FROM traffic_samples WHERE binding_id=? AND period=60",
      )
      .get(b.id).n,
    0,
  );
  r.advance(30);
  const data = await r.service.traffic(target, "month");
  assert.equal(totals(data), 1800);
  assert.equal(totals(await r.service.traffic(target, 7)), 1800);
});

test("检测到 EIP 的当轮就启动分钟采集，后台不等待网页打开或完整小时", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  await r.engine.cycle(true);
  await r.service.capturing;
  assert.ok(r.monitorCalls.some((c) => c.period === 60));
  r.advance(2);
  await r.engine.cycle(true);
  await r.service.capturing;
  const saved = r.service.history.days(target, base, Date.now());
  assert.equal(saved[0].outBytes, 40);
  assert.ok(r.service.instance(target).trafficAt);
  assert.ok(r.calls.every((c) => !c.options.write));
});

test("小时监控延迟时分钟数据继续累计，随后补回小时也不会重叠", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.advance(30);
  await r.service.traffic(target, "month");
  const monitor = r.gateway.monitor;
  r.gateway.monitor = async (...args) =>
    args[4] === 3600 ? [] : monitor(...args);
  r.advance(30);
  assert.equal(totals(await r.service.traffic(target, "month")), 1200);
  r.gateway.monitor = monitor;
  r.advance(6);
  assert.equal(totals(await r.service.traffic(target, "month")), 66 * 20);
});

test("切换边界附近的迟到响应只保存原绑定内的数据", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.advance(10);
  let entered, release;
  const ready = new Promise((r) => (entered = r)),
    held = new Promise((r) => (release = r));
  const monitor = r.gateway.monitor;
  let delayed = false;
  r.gateway.monitor = async (...args) => {
    if (!delayed) {
      delayed = true;
      entered();
      await held;
    }
    return monitor(...args);
  };
  const pending = r.service.traffic(target, "month");
  await ready;
  r.advance(-5);
  r.bindings.set(target.id, "eip-new");
  await r.service.refresh();
  r.advance(5);
  release();
  await pending;
  const result = await r.service.traffic(target, "month");
  assert.equal(totals(result), 200);
  const old = r.service.history
    .bindings(target)
    .find((b) => b.source === "eip:eip-0");
  assert.ok(
    r.store.db
      .prepare("SELECT max(at) AS at FROM traffic_samples WHERE binding_id=?")
      .get(old.id).at <=
      base + 5 * MINUTE,
  );
});

test("关闭绑定的空响应不会冻结，超过十分钟仍能补回迟到数据", async (t) => {
  const r = runtime(t, base + 5 * MINUTE);
  await r.service.refresh();
  r.advance(5);
  r.bindings.set(target.id, "eip-new");
  await r.service.refresh();
  const old = r.service.history.bindings(target)[0];
  const monitor = r.gateway.monitor;
  r.gateway.monitor = async () => [];
  r.advance(20);
  await r.service.history.range(
    target,
    old,
    old.from_at,
    old.to_at,
    60,
    "head",
  );
  r.gateway.monitor = monitor;
  r.advance(1);
  const state = await r.service.history.range(
    target,
    old,
    old.from_at,
    old.to_at,
    60,
    "head",
  );
  assert.equal(state.complete, true);
  assert.equal(
    r.service.history.days(target, base, Date.now())[0].outBytes,
    100,
  );
});

test("小时数据的早期缺口不会被两小时增量游标跳过", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const monitor = r.gateway.monitor;
  r.gateway.monitor = async (...args) =>
    (await monitor(...args)).filter(
      (p) => args[4] !== 3600 || p.timestamp !== base + 2 * HOUR,
    );
  r.advance(240);
  assert.equal(totals(await r.service.traffic(target, "month")), 3 * 60 * 20);
  r.gateway.monitor = monitor;
  r.advance(6);
  assert.equal(totals(await r.service.traffic(target, "month")), 246 * 20);
});

test("小时数据只有单方向时，另一方向继续使用分钟数据", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  const monitor = r.gateway.monitor;
  r.gateway.monitor = async (...args) =>
    args[4] === 3600 && args[1] === "INTERNET_IN" ? [] : monitor(...args);
  r.advance(60);
  const first = await r.service.traffic(target, "month");
  assert.equal(first.items[0].inBytes, 600);
  assert.equal(first.items[0].outBytes, 1200);
  r.gateway.monitor = monitor;
  r.advance(6);
  const recovered = await r.service.traffic(target, "month");
  assert.equal(recovered.items[0].inBytes, 660);
  assert.equal(recovered.items[0].outBytes, 1320);
});

test("另一个实例的旧数据迁移不能重叠已观察到的 EIP 归属", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.advance(60);
  assert.equal(totals(await r.service.traffic(target, "month")), 1200);
  for (const metric of ["INTERNET_IN", "INTERNET_OUT"])
    r.store.saveMetric(
      other,
      trafficMetric("eip:eip-0", metric),
      base + HOUR,
      1200,
    );
  r.bindings.set(target.id, "eip-new");
  r.bindings.set(other.id, "eip-0");
  await r.service.refresh();
  r.advance(5);
  assert.equal(totals(await r.service.traffic(target, "month")), 1300);
  assert.equal(totals(await r.service.traffic(other, "month")), 100);
});

test("已有旧 EIP 历史迁移到实例累计中，未知绑定时段不回填别人的历史", async (t) => {
  const r = runtime(t, base + 2 * HOUR);
  for (let n = 1; n <= 2; n++)
    for (const [metric, value] of [
      ["INTERNET_IN", 100],
      ["INTERNET_OUT", 200],
    ])
      r.store.saveMetric(
        target,
        trafficMetric("eip:old", metric),
        base + n * HOUR,
        value,
      );
  await r.service.refresh();
  r.advance(5);
  assert.equal(totals(await r.service.traffic(target, "month")), 500);
  assert.ok(r.monitorCalls.every((c) => c.t.eipAllocationId !== "old"));
  assert.ok(
    r.monitorCalls
      .filter((c) => c.t.eipAllocationId === "eip-0")
      .every((c) => c.start >= base + 2 * HOUR),
  );
});

test("旧版重叠 EIP 历史按时间分段迁移，不能简单相加同一时段", async (t) => {
  const r = runtime(t, base + 3 * HOUR);
  for (const [source, hours, value] of [
    ["eip:old", 2, 200],
    ["eip:eip-0", 3, 300],
  ])
    for (let n = 1; n <= hours; n++)
      for (const metric of ["INTERNET_IN", "INTERNET_OUT"])
        r.store.saveMetric(
          target,
          trafficMetric(source, metric),
          base + n * HOUR,
          value,
        );
  await r.service.refresh();
  const days = r.service.history.days(target, base, base + 3 * HOUR);
  assert.equal(days[0].outBytes, 700);
});

test("跨午夜和月初保持北京时间归属，分钟明细不串月", async (t) => {
  const start = Date.parse("2026-10-31T23:58:00+08:00");
  const r = runtime(t, start);
  await r.service.refresh();
  r.advance(1);
  assert.equal(totals(await r.service.traffic(target, "month")), 20);
  r.advance(3);
  const month = await r.service.traffic(target, "month");
  assert.equal(totals(month), 40);
  assert.deepEqual(
    month.items.map((d) => d.date),
    ["2026-11-01"],
  );
  const week = await r.service.traffic(target, 7);
  assert.deepEqual(
    week.items.map((d) => d.date),
    ["2026-11-01", "2026-10-31"],
  );
  assert.equal(totals(week), 80);
});

test("新 EIP 查询失败保留旧实例累计，冷却按绑定共享且恢复后继续累计", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.advance(10);
  await r.service.traffic(target, "month");
  r.bindings.set(target.id, "eip-new");
  await r.service.refresh();
  r.advance(3);
  const monitor = r.gateway.monitor;
  r.gateway.monitor = async (...args) => {
    if (args[0].eipAllocationId === "eip-new")
      throw Object.assign(new Error("Forbidden.RAM"), {
        code: "Forbidden.RAM",
      });
    return monitor(...args);
  };
  const failed = await r.service.traffic(target, "month");
  assert.equal(totals(failed), 200);
  assert.equal(failed.errors.length, 1);
  const count = r.store
    .logs()
    .filter((l) => l.action === "traffic-query").length;
  await r.service.traffic(target, "month");
  assert.equal(
    r.store.logs().filter((l) => l.action === "traffic-query").length,
    count,
  );
  r.gateway.monitor = monitor;
  r.advance(6);
  const recovered = await r.service.traffic(target, "month");
  assert.deepEqual(recovered.errors, []);
  assert.equal(totals(recovered), 19 * 20);
});

test("绑定和采样重启后保留，删除账号会清理其采样和绑定", async (t) => {
  const r = runtime(t);
  await r.service.refresh();
  r.advance(5);
  await r.service.traffic(target, "month");
  const reopened = new Store(r.dir);
  try {
    const service = new ResourceService(reopened, r.gateway);
    assert.equal(totals(await service.traffic(target, "month")), 100);
    reopened.deleteAccount(target.accountId);
    assert.equal(
      reopened.db.prepare("SELECT count(*) AS n FROM traffic_bindings").get().n,
      0,
    );
    assert.equal(
      reopened.db.prepare("SELECT count(*) AS n FROM traffic_samples").get().n,
      0,
    );
  } finally {
    reopened.close();
  }
});

test("旧数据迁移中途失败整体回滚，重试不丢历史或重复累计", async (t) => {
  const r = runtime(t, base + 2 * HOUR);
  for (let n = 1; n <= 2; n++)
    for (const metric of ["INTERNET_IN", "INTERNET_OUT"])
      r.store.saveMetric(
        target,
        trafficMetric("eip:old", metric),
        base + n * HOUR,
        100,
      );
  const history = r.service.history,
    save = history.save.bind(history);
  let calls = 0;
  history.save = (...args) => {
    if (++calls === 2) throw Error("simulated interruption");
    return save(...args);
  };
  const i = { ...target, publicNetwork: "eip", eipAllocationId: "new" };
  assert.throws(() => history.observe(i), /simulated/);
  assert.equal(history.bindings(target).length, 0);
  assert.equal(
    r.store.db.prepare("SELECT count(*) AS n FROM traffic_samples").get().n,
    0,
  );
  history.save = save;
  history.observe(i);
  assert.equal(history.days(target, base, Date.now())[0].outBytes, 200);
});
