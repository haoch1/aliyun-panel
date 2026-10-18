import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { fixture } from "./fixture.mjs";

function temporaryStore(t, create = (dir) => ({ store: new Store(dir) })) {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-log-retention-"));
  const runtime = create(dir);
  t.after(() => {
    if (runtime.store.db.isOpen) runtime.store.close();
    assert.ok(
      resolve(dir).startsWith(
        resolve(tmpdir()) + sep + "aliyun-log-retention-",
      ),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, ...runtime };
}

function seed(store, count, sameTime = false) {
  const row = store.db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?)");
  const detail = store.db.prepare(
    "INSERT INTO entities VALUES('log-detail',?,?)",
  );
  store.db.exec("BEGIN");
  try {
    for (let i = 0; i < count; i++) {
      const id = "log-" + i;
      row.run(
        id,
        new Date(1700000000000 + (sameTime ? 0 : i)).toISOString(),
        null,
        i % 2 ? "monitor-cycle" : "notification-sent",
        "fixture",
        "success",
        "fixture log",
      );
      detail.run(id, JSON.stringify({ context: { sequence: i } }));
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

test("旧设置默认保留 5000 条；新增日志按最新时间和写入顺序清理", (t) => {
  const { store } = temporaryStore(t);
  const legacy = store.settings();
  delete legacy.logRetentionLimit;
  store.config("settings", store.encrypt(legacy));
  assert.equal(store.publicSettings().logRetentionLimit, 5000);
  seed(store, 5000, true);
  const id = store.audit({ action: "monitor-cycle", detail: "newest" });
  assert.equal(store.logs().length, 5000);
  assert.equal(store.logs()[0].id, id);
  assert.equal(store.get("log-detail", "log-0"), null);
  assert.ok(store.get("log-detail", "log-4999"));
});

test("10000 调至 5000 再调至 2000，立即删除旧日志和详情，重启后仍生效", (t) => {
  const { dir, store } = temporaryStore(t);
  store.saveSettings({ ...store.settings(), logRetentionLimit: 10000 });
  seed(store, 10000);
  store.audit({ action: "monitor-cycle", context: { test: true } });
  const before = store.logs().map((r) => r.id);
  assert.equal(before.length, 10000);
  assert.equal(store.get("log-detail", "log-0"), null);
  for (const limit of [5000, 2000]) {
    store.saveSettings({ ...store.settings(), logRetentionLimit: limit });
    assert.deepEqual(
      store.logs().map((r) => r.id),
      before.slice(0, limit),
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM audit").get().n,
      limit,
    );
    assert.equal(store.list("log-detail").length, limit);
  }
  store.close();
  const reopened = new Store(dir);
  try {
    assert.equal(reopened.publicSettings().logRetentionLimit, 2000);
    assert.equal(reopened.logs().length, 2000);
    reopened.saveSettings({ ...reopened.settings(), logRetentionLimit: 10000 });
    assert.equal(reopened.logs().length, 2000);
  } finally {
    reopened.close();
  }
});

test("日志保留 API 只接受三个选项，兼容旧请求，并返回超过 5000 条的记录", async (t) => {
  const r = temporaryStore(t, fixture);
  const server = createServer(createApp(r, { dist: "not-built" }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const url = "http://127.0.0.1:" + server.address().port;
  const login = await fetch(url + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "fixture-password-123" }),
  });
  const auth = await login.json();
  const headers = {
    cookie: login.headers.get("set-cookie").split(";")[0],
    "x-csrf-token": auth.csrf,
    "content-type": "application/json",
  };
  const settings = r.store.publicSettings();
  delete settings.notifications.telegramConfigured;
  const save = (limit) =>
    fetch(url + "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...settings, logRetentionLimit: limit }),
    });
  for (const invalid of [0, 100, 3000, 20000, "5000", 5000.5, null]) {
    assert.equal((await save(invalid)).status, 400);
    assert.equal(r.store.logLimit(), 5000);
  }
  assert.equal((await save(10000)).status, 200);
  assert.equal((await save(undefined)).status, 200);
  assert.equal(r.store.logLimit(), 10000);
  r.store.clearLogs();
  seed(r.store, 5100);
  const audit = await fetch(url + "/api/audit", { headers });
  assert.equal((await audit.json()).items.length, 5100);
  const reduced = await save(2000);
  assert.equal(reduced.status, 200);
  assert.equal((await reduced.json()).logRetentionLimit, 2000);
  assert.equal(r.store.logs().length, 2000);
  assert.equal(r.store.list("log-detail").length, 2000);
  assert.deepEqual(r.calls, []);
});
