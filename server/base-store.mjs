import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditDefaultDetail } from "../shared/audit-actions.ts";

export class Store {
  onClose = new Set();
  onEvent = new Set();
  emit(type) {
    for (const listener of this.onEvent) listener(type);
  }
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, "encryption.key");
    const supplied = process.env.ENCRYPTION_KEY;
    if (supplied) {
      this.key = Buffer.from(supplied, "base64");
      if (this.key.length !== 32)
        throw new Error("ENCRYPTION_KEY 必须为 32 字节的 Base64 编码");
    } else {
      if (!existsSync(keyPath))
        writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
      this.key = readFileSync(keyPath);
    }
    this.db = new DatabaseSync(join(dir, "panel.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,meta TEXT NOT NULL,secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS traffic_limits(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_snapshots(key TEXT PRIMARY KEY,account_id TEXT NOT NULL,at INTEGER NOT NULL,expires INTEGER NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS launch_network(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS launch_network_status ON launch_network(json_extract(body, '$.status'));
      CREATE INDEX IF NOT EXISTS launch_network_at ON launch_network(json_extract(body, '$.at'));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,account TEXT,action TEXT NOT NULL,target TEXT,status TEXT NOT NULL,detail TEXT);`);
  }
  config(key, value) {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO config VALUES(?,?)")
        .run(key, JSON.stringify(value));
    return JSON.parse(
      this.db.prepare("SELECT value FROM config WHERE key=?").get(key)?.value ??
        "null",
    );
  }
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  decrypt(value) {
    const b = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(),
    );
  }
  setPassword(password) {
    const salt = randomBytes(16).toString("hex");
    this.config("admin", {
      salt,
      hash: scryptSync(password, salt, 64).toString("hex"),
    });
    this.db.exec("DELETE FROM sessions");
  }
  verifyPassword(password) {
    const a = this.config("admin");
    return (
      !!a &&
      timingSafeEqual(
        Buffer.from(a.hash, "hex"),
        scryptSync(password, a.salt, 64),
      )
    );
  }
  createSession(hours = 720) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 2160)
      throw new Error("登录有效期须为 1–2160 小时");
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(24).toString("hex");
    const expires = Date.now() + hours * 3600000;
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(this.hash(token), csrf, expires);
    return { token, csrf, expires };
  }
  hash(token) {
    return createHash("sha256").update(token).digest("hex");
  }
  session(token) {
    if (!token) return null;
    return this.sessionByHash(this.hash(token));
  }
  sessionByHash(hash) {
    return (
      this.db
        .prepare("SELECT * FROM sessions WHERE hash=? AND expires>?")
        .get(hash, Date.now()) ?? null
    );
  }
  renewSession(token, hours) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 2160)
      throw new Error("登录有效期须为 1–2160 小时");
    if (!this.session(token)) return null;
    const expires = Date.now() + hours * 3600000;
    this.db
      .prepare("UPDATE sessions SET expires=? WHERE hash=?")
      .run(expires, this.hash(token));
    return { expires };
  }
  deleteSession(token) {
    if (token)
      this.db
        .prepare("DELETE FROM sessions WHERE hash=?")
        .run(this.hash(token));
  }
  accounts() {
    return this.db
      .prepare("SELECT id,meta FROM accounts")
      .all()
      .map((r) => ({ id: r.id, ...JSON.parse(r.meta) }));
  }
  account(id) {
    const r = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(id);
    if (!r) {
      const e = new Error("阿里云账号不存在");
      e.status = 404;
      throw e;
    }
    return {
      id: r.id,
      ...JSON.parse(r.meta),
      credentials: this.decrypt(r.secret),
    };
  }
  saveAccount(meta, credentials, id = randomUUID()) {
    this.db
      .prepare("INSERT OR REPLACE INTO accounts VALUES(?,?,?)")
      .run(id, JSON.stringify(meta), this.encrypt(credentials));
    return { id, ...meta };
  }
  deleteAccount(id) {
    this.db.prepare("DELETE FROM accounts WHERE id=?").run(id);
    this.db
      .prepare(
        "DELETE FROM resource_snapshots WHERE account_id=? OR account_id='all'",
      )
      .run(id);
    this.db
      .prepare(
        "DELETE FROM traffic_limits WHERE json_extract(body, '$.accountId')=?",
      )
      .run(id);
  }
  snapshots() {
    return this.db
      .prepare("SELECT * FROM resource_snapshots ORDER BY at DESC LIMIT 5000")
      .all()
      .map((row) => ({ ...row, value: JSON.parse(row.value) }));
  }
  saveSnapshot(key, accountId, at, expires, value) {
    // Removed accounts must never be restored by an earlier in-flight read.
    if (
      accountId !== "all" &&
      !this.db.prepare("SELECT id FROM accounts WHERE id=?").get(accountId)
    )
      return false;
    this.db
      .prepare("INSERT OR REPLACE INTO resource_snapshots VALUES(?,?,?,?,?)")
      .run(key, accountId, at, expires, JSON.stringify(value));
    this.db.exec(
      "DELETE FROM resource_snapshots WHERE key IN (SELECT key FROM resource_snapshots ORDER BY at DESC LIMIT -1 OFFSET 5000)",
    );
    return true;
  }
  expireSnapshot(key) {
    this.db
      .prepare("UPDATE resource_snapshots SET expires=0 WHERE key=?")
      .run(key);
  }
  deleteSnapshot(key) {
    this.db.prepare("DELETE FROM resource_snapshots WHERE key=?").run(key);
  }
  audit({
    account = "",
    action,
    target = "",
    status = "success",
    detail = "",
  }) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?)")
      .run(
        id,
        new Date().toISOString(),
        account,
        action,
        target,
        status,
        (detail || auditDefaultDetail(action, status)).slice(0, 4000),
      );
    this.db.exec(
      "DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY at DESC LIMIT -1 OFFSET 5000)",
    );
    this.emit("audit");
    return id;
  }
  updateAudit(id, { status, detail }) {
    const text = (detail || auditDefaultDetail("", status)).slice(0, 4000);
    const changed = this.db
      .prepare(
        "UPDATE audit SET status=?,detail=? WHERE id=? AND status='submitted' AND (status<>? OR detail<>?)",
      )
      .run(status, text, id, status, text).changes;
    if (changed) this.emit("audit");
    return Number(changed);
  }
  logs() {
    return this.db
      .prepare("SELECT * FROM audit ORDER BY at DESC LIMIT 200")
      .all();
  }
  clearLogs() {
    const deleted = Number(this.db.prepare("DELETE FROM audit").run().changes);
    this.emit("audit");
    return deleted;
  }
  saveLaunchNetwork(job) {
    const progress = (value) =>
      JSON.stringify(
        value && [
          value.status,
          (value.instances || []).map((item) => [
            item.name,
            item.stage,
            item.detail,
          ]),
        ],
      );
    const previous = progress(this.launchNetwork(job.id));
    this.db
      .prepare("INSERT OR REPLACE INTO launch_network VALUES(?,?)")
      .run(job.id, JSON.stringify(job));
    if (previous !== progress(job)) this.emit("operations");
  }
  launchNetwork(id) {
    const row = this.db
      .prepare("SELECT body FROM launch_network WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body) : null;
  }
  latestInstanceJob(accountId, region, name) {
    const row = this.db
      .prepare(
        `SELECT body FROM launch_network
      WHERE json_extract(body, '$.accountId')=? AND json_extract(body, '$.region')=?
      AND (json_extract(body, '$.action')='launch' OR json_extract(body, '$.resource')='instances')
      AND EXISTS (SELECT 1 FROM json_each(body, '$.instances') WHERE json_extract(value, '$.name')=?)
      ORDER BY json_extract(body, '$.at') DESC LIMIT 1`,
      )
      .get(accountId, region, name);
    return row ? JSON.parse(row.body) : null;
  }
  launchNetworks({ pendingOnly = false, recentSince } = {}) {
    const query = pendingOnly
      ? "SELECT body FROM launch_network WHERE json_extract(body, '$.status')='pending'"
      : recentSince !== undefined
        ? "SELECT body FROM launch_network WHERE json_extract(body, '$.status')='pending' OR json_extract(body, '$.at')>?"
        : "SELECT body FROM launch_network";
    return this.db
      .prepare(query)
      .all(...(pendingOnly || recentSince === undefined ? [] : [recentSince]))
      .map((r) => JSON.parse(r.body));
  }
  trafficLimit(id) {
    const row = this.db
      .prepare("SELECT body FROM traffic_limits WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body) : null;
  }
  trafficLimits() {
    return this.db
      .prepare("SELECT body FROM traffic_limits")
      .all()
      .map((r) => JSON.parse(r.body));
  }
  saveTrafficLimit(rule) {
    this.db
      .prepare("INSERT OR REPLACE INTO traffic_limits VALUES(?,?)")
      .run(rule.key, JSON.stringify(rule));
  }
  close() {
    for (const stop of this.onClose) stop();
    this.db.close();
  }
}
