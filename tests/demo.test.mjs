import test from "node:test";
import assert from "node:assert/strict";
import { demoApi, startDemoAutomation } from "../src/demo/index.ts";
import { defaultNotificationTypes } from "../shared/notification-preferences.ts";

globalThis.window = new EventTarget();
const request = (path, body, method = body === undefined ? "GET" : "POST") =>
  demoApi(path, body, method);
const settle = () => new Promise((resolve) => setTimeout(resolve, 1100));

test("demo is usable without authentication and rejects real-only endpoints", async () => {
  const auth = await request("/auth");
  assert.equal(auth.authenticated, true);
  assert.equal(auth.demo, true);
  const settings = await request("/settings");
  assert.deepEqual(settings.notifications.events, defaultNotificationTypes);
  assert.equal(settings.dailyReport, true);
  await assert.rejects(
    request("/backup/export", { password: "test-only-password" }),
    /不会访问真实接口/,
  );
  assert.equal((await request("/accounts")).items.length, 2);
});

test("demo account scope, manual hold and keepalive produce coherent states", async () => {
  const hk = await request("/instances?region=cn-hongkong");
  assert.equal(hk.items.length, 2);
  const backup = hk.items.find((i) => i.id === "demo-backup");
  await request(
    "/rules",
    { target: backup, rule: { ...backup.rule, keepAlive: true } },
    "PUT",
  );
  assert.equal(
    (await request("/instances")).items.find((i) => i.id === backup.id).status,
    "Stopped",
  );
  await request("/operations", { ...backup, action: "resume" });
  await request("/instances");
  await settle();
  assert.equal(
    (await request("/instances")).items.find((i) => i.id === backup.id).status,
    "Running",
  );
  await request("/operations", { ...backup, action: "stop" });
  await settle();
  const held = (await request("/instances")).items.find(
    (i) => i.id === backup.id,
  );
  assert.equal(held.status, "Stopped");
  assert.equal(held.rule.hold, "manual");
});

test("demo AccessKey discovery, selected import and mixed-currency billing are local", async () => {
  const d = await request("/connections/discover", {
    accessKeyId: "fake-key",
    accessKeySecret: "fake-secret",
    site: "international",
    name: "演示 ECS",
    instanceId: "i-demo-found-1",
  });
  assert.equal(d.items.length, 1);
  const chosen = d.items[0];
  const result = await request("/connections/import", {
    token: d.token,
    targets: [{ id: chosen.id, region: chosen.region }],
    keepAlive: false,
  });
  assert.equal(result.added, 1);
  const list = await request("/instances?accountId=" + result.accountId);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].region, "ap-southeast-1");
  const bills = await request("/billing");
  assert.ok(bills.items.some((i) => i.currency === "CNY"));
  assert.ok(bills.items.some((i) => i.currency === "USD"));
  for (const path of ["/launch", "/firewall", "/keys", "/command", "/terminal"])
    await assert.rejects(request(path, {}), /不会访问真实接口/);
  await request(
    "/monitors",
    { accountId: result.accountId, id: chosen.id, region: chosen.region },
    "DELETE",
  );
  assert.equal((await request("/accounts")).items.length, 2);
});

test("demo responses cannot mutate state and notification secrets are not echoed", async () => {
  const accounts = await request("/accounts");
  accounts.items.length = 0;
  assert.equal((await request("/accounts")).items.length, 2);
  const settings = await request("/settings");
  settings.notifications.telegramChatId = "fake-demo-chat";
  settings.notifications.telegramToken = "fake-demo-token";
  const saved = await request("/settings", settings, "PUT");
  assert.equal(saved.notifications.webhook, undefined);
  assert.equal(saved.notifications.telegramConfigured, true);
  assert.equal(saved.notifications.telegramToken, "");
  assert.deepEqual((await request("/notifications/test", {})).channels, [
    "telegram",
  ]);
});

test("demo reads and refresh stay read-only; explicit automation starts keepalive and stops over-limit instances", async (t) => {
  const scan = await request("/connections/discover", {
    accessKeyId: "refresh-regression-key",
    accessKeySecret: "fake-secret",
    site: "china",
    name: "刷新测试",
    instanceId: "i-demo-running",
  });
  const imported = await request("/connections/import", {
    token: scan.token,
    targets: scan.items.map(({ id, region }) => ({ id, region })),
    keepAlive: true,
  });
  const secondScan = await request("/connections/discover", {
    accessKeyId: "refresh-regression-key",
    accessKeySecret: "fake-secret",
    site: "china",
    name: "保活测试",
    instanceId: "i-demo-backup",
  });
  await request("/connections/import", {
    token: secondScan.token,
    targets: secondScan.items.map(({ id, region }) => ({ id, region })),
    keepAlive: true,
  });
  const path = "/instances?accountId=" + imported.accountId;
  const items = (await request(path)).items;
  t.after(async () => {
    for (const i of items) await request("/monitors", i, "DELETE");
  });
  const running = items.find((i) => i.status === "Running");
  const stopped = items.find((i) => i.status === "Stopped");
  await request(
    "/rules",
    {
      target: running,
      rule: { ...running.rule, thresholdEnabled: true, thresholdPercent: 1 },
    },
    "PUT",
  );
  const cyclesBefore = (await request("/audit")).items.filter(
    (l) => l.action === "monitor-cycle",
  ).length;
  for (let n = 0; n < 2; n++) {
    await request("/refresh", { accountId: imported.accountId, region: "all" });
    const snapshot = await request(path);
    assert.equal(
      snapshot.items.find((i) => i.id === running.id).status,
      "Running",
    );
    assert.equal(
      snapshot.items.find((i) => i.id === stopped.id).status,
      "Stopped",
    );
    assert.ok(
      snapshot.items.every((i) => !i.rule.lastCheck && !i.rule.hold && !i.job),
    );
  }
  assert.equal(
    (await request("/jobs")).items.filter(
      (j) => j.accountId === imported.accountId,
    ).length,
    0,
  );
  assert.equal(
    (await request("/audit")).items.filter((l) => l.action === "monitor-cycle")
      .length,
    cyclesBefore,
  );
  await request("/check", {});
  const jobs = (await request("/jobs")).items.filter(
    (j) => j.accountId === imported.accountId,
  );
  assert.equal(jobs.find((j) => j.instanceId === running.id).source, "traffic");
  assert.equal(
    jobs.find((j) => j.instanceId === stopped.id).source,
    "keepalive",
  );
  await settle();
  const checked = (await request(path)).items;
  assert.equal(checked.find((i) => i.id === running.id).status, "Stopped");
  assert.equal(checked.find((i) => i.id === running.id).rule.hold, "traffic");
  assert.equal(checked.find((i) => i.id === stopped.id).status, "Running");
});

test("demo automation follows its own timer, independent of reads and view refreshes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  await request("/check", {});
  const count = () =>
    request("/audit").then(
      (v) => v.items.filter((l) => l.action === "monitor-cycle").length,
    );
  const before = await count();
  const stop = startDemoAutomation();
  t.after(stop);
  t.mock.timers.tick(59000);
  await request("/refresh", { accountId: "all", region: "all" });
  await request("/instances");
  assert.equal(await count(), before);
  t.mock.timers.tick(1000);
  assert.equal(await count(), before + 1);
  assert.equal(
    (await request("/audit")).items.find((l) => l.action === "monitor-cycle")
      .context.source,
    "automatic",
  );
  stop();
  t.mock.timers.tick(60000);
  assert.equal(await count(), before + 1);
});
test("demo combined instance refresh runs rules only for the chosen account", async (t) => {
  async function add(id, accessKeyId) {
    const scan = await request("/connections/discover", {
      accessKeyId,
      accessKeySecret: "demo-only-secret",
      site: "china",
      name: id,
      instanceId: id,
    });
    const imported = await request("/connections/import", {
      token: scan.token,
      targets: scan.items.map(({ id, region }) => ({ id, region })),
      keepAlive: true,
    });
    return (await request("/instances?accountId=" + imported.accountId))
      .items[0];
  }
  const inside = await add("i-demo-backup-combined", "combined-key"),
    outside = await add("i-demo-backup-outside", "outside-key");
  t.after(async () => {
    await request("/monitors", inside, "DELETE");
    await request("/monitors", outside, "DELETE");
  });
  await request("/refresh", {
    accountId: inside.accountId,
    region: "all",
    check: true,
  });
  const jobs = (await request("/jobs")).items;
  assert.ok(
    jobs.some((j) => j.instanceId === inside.id && j.source === "keepalive"),
  );
  assert.ok(!jobs.some((j) => j.instanceId === outside.id));
  const resources = (await request("/audit")).items.find(
    (entry) => entry.action === "monitor-cycle",
  ).context.resources;
  assert.deepEqual(
    resources.map((i) => i.id),
    [inside.id],
  );
  await settle();
  const items = (await request("/instances")).items;
  assert.equal(items.find((i) => i.id === inside.id).status, "Running");
  assert.equal(items.find((i) => i.id === outside.id).status, "Stopped");
});

test("demo notification choices persist and filter unchecked automatic events", async () => {
  const previous = await request("/settings");
  try {
    const settings = structuredClone(previous);
    settings.notifications.telegramToken = "fixture-demo-token";
    settings.notifications.telegramChatId = "fixture-demo-chat";
    settings.notifications.events = ["daily"];
    settings.dailyReport = false;
    let saved = await request("/settings", settings, "PUT");
    assert.deepEqual(saved.notifications.events, ["daily"]);
    assert.equal(saved.dailyReport, true);
    assert.equal(saved.notifications.mode, undefined);
    const before = (await request("/notifications")).items.length;
    await request("/check", {});
    await settle();
    const added = (await request("/notifications")).items.slice(
      0,
      -before || undefined,
    );
    assert.ok(added.every((i) => i.kind === "report"));
    saved.notifications.events = [];
    saved.dailyReport = true;
    saved = await request("/settings", saved, "PUT");
    assert.equal(saved.dailyReport, false);
    assert.deepEqual((await request("/settings")).notifications.events, []);
    const emptyCount = (await request("/notifications")).items.length;
    await request("/check", {});
    await settle();
    assert.equal((await request("/notifications")).items.length, emptyCount);
    await request("/notifications/test", {});
    assert.equal(
      (await request("/notifications")).items.length,
      emptyCount + 1,
    );
  } finally {
    await request("/settings", previous, "PUT");
  }
});

test("演示模式移除全部实例后不刷空检测日志，也不发送空汇总", async (t) => {
  for (const i of (await request("/instances")).items)
    await request("/monitors", i, "DELETE");
  const settings = await request("/settings");
  settings.notifications.telegramToken = "fixture-demo-token";
  settings.notifications.telegramChatId = "fixture-demo-chat";
  settings.notifications.events = ["daily", "cycle"];
  settings.reportTime = "00:00";
  settings.timezone = "Asia/Shanghai";
  await request("/settings", settings, "PUT");
  const logCount = (await request("/audit")).items.length;
  const notificationCount = (await request("/notifications")).items.length;
  t.mock.timers.enable({
    apis: ["Date", "setInterval"],
    now: Date.parse("2026-10-15T16:00:00Z"),
  });
  const stop = startDemoAutomation();
  t.after(stop);
  await request("/check", {});
  t.mock.timers.tick(15 * 60000);
  assert.equal((await request("/audit")).items.length, logCount);
  assert.equal(
    (await request("/notifications")).items.length,
    notificationCount,
  );
});
