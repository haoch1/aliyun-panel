import {
  defaultNotificationTypes,
  notificationSelection,
} from "../shared/notification-preferences.ts";
import { randomUUID } from "node:crypto";
import { Store as BaseStore } from "./base-store.mjs";
export const resourceKey = ({ accountId, region, id }) =>
  JSON.stringify([accountId, region, id]);
export const defaultRule = ({ accountId, region, id }) => ({
  accountId,
  region,
  id,
  keepAlive: null,
  paused: false,
  thresholdEnabled: false,
  thresholdPercent: 90,
  thresholdAction: "stop",
  thresholdUnit: "percent",
  thresholdGiB: 180,
  autoRecover: false,
  stoppedMode: "KeepCharging",
  scheduleStopEnabled: true,
  scheduleEnabled: false,
  start: "08:00",
  stop: "23:00",
  timezone: "Asia/Shanghai",
});
export const defaultSettings = () => ({
  keepAliveDefault: true,
  billingEnabled: true,
  checkInterval: 60,
  billingInterval: 3600,
  dailyReport: true,
  reportTime: "00:00",
  timezone: "Asia/Shanghai",
  notifications: {
    telegramToken: "",
    telegramChatId: "",
    telegramEnabled: true,
    events: [...defaultNotificationTypes],
    apiBase: "https://api.telegram.org",
  },
});
export class Store extends BaseStore {
  constructor(dir) {
    super(dir);
    this.dir = dir;
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entity_kind ON entities(kind);`);
  }
  get(kind, id) {
    const r = this.db
      .prepare("SELECT body FROM entities WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? JSON.parse(r.body) : null;
  }
  list(kind) {
    return this.db
      .prepare("SELECT body FROM entities WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(r.body));
  }
  put(kind, id, body) {
    this.db
      .prepare("INSERT OR REPLACE INTO entities VALUES(?,?,?)")
      .run(kind, id, JSON.stringify(body));
    this.emit(kind);
    return body;
  }
  remove(kind, id) {
    this.db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id);
    this.emit(kind);
  }
  rule(t) {
    return { ...defaultRule(t), ...this.get("rule", resourceKey(t)) };
  }
  saveRule(t, changes) {
    const old = this.rule(t);
    return this.put("rule", resourceKey(t), {
      ...old,
      ...changes,
      accountId: t.accountId,
      region: t.region,
      id: t.id,
      revision: randomUUID(),
    });
  }
  progress(t, changes) {
    return this.put("rule", resourceKey(t), { ...this.rule(t), ...changes });
  }
  settings() {
    const stored = this.config("settings");
    const old = stored ? this.decrypt(stored) : {};
    const defaults = defaultSettings();
    const notifications = Object.fromEntries(
      Object.keys(defaults.notifications).map((k) => [
        k,
        old.notifications?.[k] ?? defaults.notifications[k],
      ]),
    );
    if (Array.isArray(old.notifications?.events))
      notifications.events = notificationSelection(old);
    else if (old.notifications?.mode !== undefined) {
      // Keep legacy preferences until the user saves checkbox selections
      delete notifications.events;
      notifications.mode = old.notifications.mode;
    }
    return { ...defaults, ...old, keepAliveDefault: true, notifications };
  }
  publicSettings() {
    const s = this.settings();
    const { mode, ...notifications } = s.notifications;
    return {
      ...s,
      notifications: {
        ...notifications,
        events: notificationSelection(s),
        telegramToken: "",
        telegramConfigured: !!s.notifications.telegramToken,
      },
    };
  }
  saveSettings(value) {
    if (Array.isArray(value.notifications.events))
      value = {
        ...value,
        dailyReport: value.notifications.events.includes("daily"),
        notifications: {
          ...value.notifications,
          events: notificationSelection(value),
        },
      };
    this.config("settings", this.encrypt({ ...value, keepAliveDefault: true }));
    this.emit("settings");
  }
  redact(value) {
    const secrets = this.accounts()
      .flatMap((a) => Object.values(this.account(a.id).credentials))
      .concat(this.settings().notifications.telegramToken)
      .filter((v) => typeof v === "string" && v.length >= 6);
    const walk = (v, key = "") => {
      if (/secret|token|password|authorization/i.test(key)) return "[已隐藏]";
      if (typeof v === "string")
        return secrets.reduce(
          (text, secret) => text.split(secret).join("[已隐藏]"),
          v,
        );
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v && typeof v === "object")
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, walk(x, k)]),
        );
      return v;
    };
    return walk(value);
  }
  audit(entry) {
    const safe = this.redact(entry);
    const id = super.audit(safe);
    this.put("log-detail", id, {
      category:
        safe.category ||
        (/keepalive|traffic|schedule/.test(safe.action)
          ? "automation"
          : /notification/.test(safe.action)
            ? "notification"
            : /billing/.test(safe.action)
              ? "billing"
              : "operation"),
      level: safe.level || (safe.status === "failed" ? "error" : "info"),
      context: safe.context || {},
    });
    this.db.exec(
      "DELETE FROM entities WHERE kind='log-detail' AND id NOT IN (SELECT id FROM audit)",
    );
    return id;
  }
  updateAudit(id, entry) {
    const safe = this.redact(entry),
      changed = super.updateAudit(id, safe);
    if (changed) {
      const old = this.get("log-detail", id) || {};
      this.put("log-detail", id, {
        ...old,
        level:
          safe.level ||
          (safe.status === "failed"
            ? "error"
            : safe.status === "submitted"
              ? "warning"
              : "info"),
        context: { ...old.context, ...safe.context },
      });
    }
    return changed;
  }
  logs() {
    return this.db
      .prepare("SELECT * FROM audit ORDER BY at DESC LIMIT 5000")
      .all()
      .map((r) => ({ ...r, ...this.get("log-detail", r.id) }));
  }
  clearLogs() {
    this.db.exec("DELETE FROM entities WHERE kind='log-detail'");
    return super.clearLogs();
  }
  deleteAccount(id) {
    super.deleteAccount(id);
    this.db
      .prepare("DELETE FROM entities WHERE json_extract(body,'$.accountId')=?")
      .run(id);
    this.emit("accounts");
  }
  saveMetric(t, metric, at, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO entities VALUES(?,?,?)")
      .run(
        "metric",
        JSON.stringify([resourceKey(t), metric, at]),
        JSON.stringify({ ...t, metric, at, value }),
      );
  }
  metrics(t, metric, start, end) {
    return this.db
      .prepare(
        "SELECT body FROM entities WHERE kind='metric' AND json_extract(body,'$.accountId')=? AND json_extract(body,'$.region')=? AND json_extract(body,'$.id')=? AND json_extract(body,'$.metric')=? AND json_extract(body,'$.at')>? AND json_extract(body,'$.at')<=? ORDER BY json_extract(body,'$.at')",
      )
      .all(t.accountId, t.region, t.id, metric, start, end)
      .map((r) => JSON.parse(r.body));
  }
  prune() {
    this.db
      .prepare(
        "DELETE FROM entities WHERE kind='metric' AND json_extract(body,'$.at')<?",
      )
      .run(Date.now() - 93 * 86400000);
  }
}
