import { randomUUID } from "node:crypto";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { errorText } from "./aliyun.mjs";
import { formatNotification } from "../shared/notifications.ts";
import {
  notificationType,
  wantsNotification,
} from "../shared/notification-preferences.ts";
const short = (v) =>
  String(v || "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
export const telegramText = (item) => formatNotification(item, true);
export function telegramRequest(n, payload) {
  const url = new URL(
    n.apiBase.replace(/\/$/, "") + "/bot" + n.telegramToken + "/sendMessage",
  );
  const body = JSON.stringify(payload);
  const agent = new (url.protocol === "https:" ? HttpsAgent : HttpAgent)({
    proxyEnv: process.env,
  });
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        agent,
        signal: AbortSignal.timeout(15000),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 1024 * 1024)
            req.destroy(new Error("Telegram 响应过大"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            let data;
            try {
              data = JSON.parse(text);
            } catch {
              /* Some reverse proxies return a plain HTTP error. */
            }
            if (res.statusCode !== 200 || !data?.ok) {
              const error = new Error(
                "Telegram HTTP " +
                  res.statusCode +
                  (data?.description
                    ? "：" + short(data.description)
                    : "：发送失败"),
              );
              const retryAfter = Number(data?.parameters?.retry_after);
              if (Number.isSafeInteger(retryAfter) && retryAfter > 0)
                error.retryAfter = retryAfter;
              throw error;
            }
            resolve(data);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  }).finally(() => agent.destroy());
}
export class Notifications {
  constructor(store, { send } = {}) {
    this.store = store;
    this.sendOverride = send;
    this.running = false;
  }
  channels() {
    const n = this.store.settings().notifications;
    return n.telegramEnabled && n.telegramToken && n.telegramChatId
      ? ["telegram"]
      : [];
  }
  event(key, title, message, options = {}) {
    const level =
      options.level ||
      (/失败|异常|错误|需核对/.test(title + message)
        ? "error"
        : /告警|阈值/.test(title)
          ? "warning"
          : "info");
    const type = notificationType({ title, level, ...options });
    if (
      !options.force &&
      !wantsNotification(this.store.settings(), {
        title,
        level,
        ...options,
        type,
      })
    )
      return;
    for (const channel of this.channels()) {
      const id = key + ":" + channel;
      if (this.store.get("outbox", id)) continue;
      const { force, ...metadata } = options;
      const at = Date.now();
      this.store.put("outbox", id, {
        id,
        channel,
        title,
        message,
        level,
        ...metadata,
        type,
        manualTest: !!force,
        status: "queued",
        attempts: 0,
        nextAt: at,
        at,
      });
      this.store.audit({
        action: "notification-queued",
        category: "notification",
        detail: title + " · 等待发送",
        context: {
          notificationId: id,
          title,
          level,
          kind: options.kind,
          content: formatNotification({
            title,
            message,
            level,
            ...metadata,
            at,
          }),
        },
      });
    }
  }
  test() {
    this.event(
      "test:" + randomUUID(),
      "TG 通知测试",
      "连接正常，后续按勾选的通知类型推送",
      { force: true },
    );
    return this.channels();
  }
  async send(item) {
    if (item.channel !== "telegram") throw new Error("通知通道已移除");
    if (this.sendOverride) return this.sendOverride(item);
    const n = this.store.settings().notifications;
    if (!this.channels().length) throw new Error("Telegram 配置未完成");
    return telegramRequest(n, {
      chat_id: n.telegramChatId,
      text: telegramText(item),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const item of this.store
        .list("outbox")
        .filter((x) => x.status === "queued" && x.nextAt <= Date.now())
        .slice(0, 3)) {
        if ((this.store.get("health", "telegram")?.retryAt || 0) > Date.now())
          break;
        const n = this.store.settings().notifications;
        if (
          item.channel !== "telegram" ||
          !n.telegramEnabled ||
          (!item.manualTest && !wantsNotification(this.store.settings(), item))
        ) {
          this.store.put("outbox", item.id, {
            ...item,
            status: "skipped",
            error: "通知已关闭或未勾选此类通知",
          });
          continue;
        }
        try {
          await this.send(item);
          this.store.put("outbox", item.id, {
            ...item,
            status: "sent",
            sentAt: Date.now(),
            attempts: item.attempts + 1,
            error: undefined,
          });
          this.store.audit({
            action: "notification-sent",
            category: "notification",
            detail: item.title + " · 已发送",
            context: {
              notificationId: item.id,
              title: item.title,
              attempts: item.attempts + 1,
              content: formatNotification(item),
            },
          });
        } catch (e) {
          const attempts = item.attempts + 1;
          const retryAt =
            Number.isSafeInteger(e.retryAfter) && e.retryAfter > 0
              ? Date.now() + e.retryAfter * 1000
              : 0;
          if (retryAt) this.store.put("health", "telegram", { retryAt });
          this.store.put("outbox", item.id, {
            ...item,
            attempts,
            status: attempts >= 5 ? "failed" : "queued",
            error: errorText(
              e,
              Object.values(this.store.settings().notifications).filter(
                (x) => typeof x === "string",
              ),
              "Telegram",
            ),
            nextAt: Math.max(
              retryAt,
              Date.now() + Math.min(3600000, 30000 * 2 ** attempts),
            ),
          });
          const failed = this.store.get("outbox", item.id);
          this.store.audit({
            action: "notification-retry",
            category: "notification",
            status: "failed",
            level: attempts >= 5 ? "error" : "warning",
            detail: item.title + " · " + failed.error,
            context: {
              notificationId: item.id,
              attempts,
              nextAt: failed.nextAt,
              phase: failed.status,
            },
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
