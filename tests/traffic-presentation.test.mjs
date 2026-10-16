import test from "node:test";
import assert from "node:assert/strict";
import {
  chartTooltipPosition,
  trafficBars,
  trafficTotals,
  trafficRange,
  singleDirectionTraffic,
} from "../shared/traffic-presentation.ts";

test("实例月流量取整月入出累计值较大者，不累加每日较大值或双向总量", () => {
  const rows = [
    { date: "2026-10-01", inBytes: 100, outBytes: 20 },
    { date: "2026-10-02", inBytes: 10, outBytes: 200 },
  ];
  assert.equal(singleDirectionTraffic(rows), 220);
  assert.equal(
    singleDirectionTraffic(
      rows.map((r) => ({ ...r, inBytes: r.outBytes, outBytes: r.inBytes })),
    ),
    220,
  );
  assert.equal(singleDirectionTraffic([]), null);
  assert.equal(
    singleDirectionTraffic([{ date: "2026-10-01", inBytes: 0, outBytes: 0 }]),
    0,
  );
  for (const missing of [null, NaN, Infinity, -1]) {
    assert.equal(
      singleDirectionTraffic([
        { date: "2026-10-01", inBytes: missing, outBytes: 200 },
      ]),
      null,
    );
  }
});

test("流量汇总使用所选范围的入出字节，柱状图按合计排序与缩放且不修改原数据", () => {
  const rows = [
    { date: "2026-10-02", inBytes: 80, outBytes: 20 },
    { date: "2026-10-01", inBytes: 10, outBytes: 40 },
  ];
  assert.deepEqual(trafficTotals(rows), {
    inbound: 90,
    outbound: 60,
    total: 150,
  });
  assert.deepEqual(
    trafficBars(rows).map((x) => [x.date, x.total, x.percent]),
    [
      ["2026-10-01", 50, 50],
      ["2026-10-02", 100, 100],
    ],
  );
  assert.equal(rows[0].date, "2026-10-02");
  assert.deepEqual(trafficTotals(rows.slice(1)), {
    inbound: 10,
    outbound: 40,
    total: 50,
  });
});

test("缺失或非法流量不补零，空数据与真实零流量分开", () => {
  assert.deepEqual(trafficTotals([]), {
    inbound: null,
    outbound: null,
    total: null,
  });
  assert.deepEqual(
    trafficTotals([{ date: "2026-10-01", inBytes: 0, outBytes: 0 }]),
    { inbound: 0, outbound: 0, total: 0 },
  );
  for (const missing of [null, NaN, Infinity, -1]) {
    const rows = [{ date: "2026-10-01", inBytes: missing, outBytes: 50 }];
    assert.deepEqual(trafficTotals(rows), {
      inbound: null,
      outbound: 50,
      total: null,
    });
    assert.equal(trafficBars(rows)[0].percent, 0);
  }
});

test("提示框跟随鼠标，右边缘换到左边，上边缘换到下方，四角和窄屏不越界", () => {
  const size = { width: 190, height: 130 },
    viewport = { width: 1280, height: 800 };
  assert.deepEqual(chartTooltipPosition({ x: 400, y: 300 }, size, viewport), {
    left: 412,
    top: 158,
  });
  assert.deepEqual(chartTooltipPosition({ x: 430, y: 320 }, size, viewport), {
    left: 442,
    top: 178,
  });
  assert.ok(
    chartTooltipPosition({ x: 1270, y: 300 }, size, viewport).left +
      size.width <
      1270,
  );
  assert.ok(chartTooltipPosition({ x: 400, y: 8 }, size, viewport).top > 8);
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 360, height: 640 },
  ]) {
    for (const anchor of [
      { x: 1, y: 1 },
      { x: viewport.width - 1, y: 1 },
      { x: 1, y: viewport.height - 1 },
      { x: viewport.width - 1, y: viewport.height - 1 },
    ]) {
      const p = chartTooltipPosition(anchor, size, viewport);
      assert.ok(p.left >= 8 && p.top >= 8);
      assert.ok(p.left + size.width <= viewport.width - 8);
      assert.ok(p.top + size.height <= viewport.height - 8);
    }
  }
});

test("范围显示与后台北京时间一致，不受浏览器系统时区影响", () => {
  assert.equal(
    trafficRange(
      Date.parse("2026-09-30T16:00:00Z"),
      Date.parse("2026-10-15T11:00:00Z"),
    ),
    "2026-10-01 00:00 → 2026-10-15 19:00（UTC+08:00）",
  );
  assert.equal(trafficRange(undefined, undefined), "—");
});
