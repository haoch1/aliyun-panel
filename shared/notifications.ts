import { displayTrafficUnits } from "./presentation.ts";
import { notificationType } from "./notification-preferences.ts";

export interface NotificationMessage {
  title: string;
  type?: import("./notification-preferences").NotificationType;
  message?: string;
  level?: string;
  kind?: string;
  at?: number | string;
  account?: { name: string };
  instance?: {
    name: string;
    region?: string;
    usage?: { used: number | null; total: number | null };
  };
}
const escape = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (v: string, limit: number) =>
  Array.from(v).slice(0, limit).join("");
const flags: Record<string, string> = {
  "cn-hongkong": "🇭🇰",
  "cn-": "🇨🇳",
  "ap-southeast-1": "🇸🇬",
  "ap-southeast-3": "🇲🇾",
  "ap-southeast-5": "🇮🇩",
  "ap-southeast-6": "🇵🇭",
  "ap-southeast-7": "🇹🇭",
  "ap-southeast-2": "🇦🇺",
  "ap-northeast-1": "🇯🇵",
  "ap-northeast-2": "🇰🇷",
  "ap-south-1": "🇮🇳",
  "us-": "🇺🇸",
  "eu-central-1": "🇩🇪",
  "eu-west-1": "🇬🇧",
  "me-east-1": "🇦🇪",
  "me-central-1": "🇸🇦",
};
function regionFlag(region = "") {
  return (
    flags[region] ||
    Object.entries(flags).find(([prefix]) => region.startsWith(prefix))?.[1] ||
    ""
  );
}
const beijingTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
function notificationTime(value: number | string | undefined) {
  if (value == null) return "";
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "";
  const parts = Object.fromEntries(
    beijingTime.formatToParts(time).map((p) => [p.type, p.value]),
  );
  return `🕒 ${parts.year}.${parts.month}.${parts.day} - ${parts.hour}:${parts.minute}:${parts.second}`;
}
export function notificationIcon(item: NotificationMessage): string {
  const type = notificationType(item);
  // Failures take precedence over the action or summary being reported
  if (
    item.level === "error" ||
    type === "operation-error" ||
    type === "error" ||
    type === "billing"
  )
    return "🔴";
  if (item.level === "warning" || type === "threshold") return "🟠";
  if (type === "status" && !/测试/.test(item.title)) return "🟠";
  return "🟢";
}
export function formatNotification(item: NotificationMessage, html = false) {
  const encode = (v: string) => (html ? escape(v) : v);
  const bold = (v: string) => (html ? "<b>" + encode(v) + "</b>" : v);
  const icon = notificationIcon(item);
  const body: string[] = [];
  if (item.instance) {
    const flag = regionFlag(item.instance.region);
    body.push(bold((flag ? flag + " " : "") + clip(item.instance.name, 48)));
    const u = item.instance.usage;
    if (
      /流量/.test(item.title) &&
      u?.used != null &&
      u.total != null &&
      Number.isFinite(u.used) &&
      Number.isFinite(u.total) &&
      u.used >= 0 &&
      u.total > 0
    ) {
      body.push(
        "本月流量 " + bold(((u.used / u.total) * 100).toFixed(1) + "%"),
      );
      body.push(
        "已用 " +
          (u.used / 1024 ** 3).toFixed(1) +
          " / " +
          (u.total / 1024 ** 3).toFixed(1) +
          " GB · 剩余 " +
          (Math.max(0, u.total - u.used) / 1024 ** 3).toFixed(1) +
          " GB",
      );
    }
  }
  if (item.account) body.push(bold(clip(item.account.name, 48)));
  if (item.message)
    body.push(
      encode(
        item.kind === "report"
          ? clip(displayTrafficUnits(item.message), 2800)
          : item.kind === "cycle"
            ? clip(displayTrafficUnits(item.message), 1500)
            : clip(
                displayTrafficUnits(item.message).replace(/\s+/g, " ").trim(),
                180,
              ),
      ),
    );
  const sections = [bold(icon + " " + clip(item.title, 80))];
  if (body.length)
    sections.push(
      html
        ? "<blockquote>" + body.join("\n") + "</blockquote>"
        : body.join("\n"),
    );
  const time = notificationTime(item.at);
  if (time) sections.push(time);
  return sections.join("\n\n");
}
export function operationTitle(source: string, action: string) {
  return (
    ((
      {
        keepalive: "保活",
        manual: "手动",
        traffic: "流量保护",
        schedule: "定时",
      } as Record<string, string>
    )[source] || "自动") + (action === "start" ? "开机" : "关机")
  );
}
export function cycleSummary(items: any[]) {
  return (
    items.length +
    " 台 · 运行 " +
    items.filter((i) => i.status === "Running").length +
    " · 已停止 " +
    items.filter((i) => i.status === "Stopped").length +
    " · 异常 " +
    items.filter((i) => i.error || i.statusError || i.usage?.error).length
  );
}
export function cycleDetails(items: any[]) {
  const lines = [cycleSummary(items)];
  for (const i of items.slice(0, 5)) {
    const status =
      i.status === "Running"
        ? "运行"
        : i.status === "Stopped"
          ? "停止"
          : "状态待同步";
    const u = i.usage;
    const flow =
      u?.used != null && u?.total > 0 && Number.isFinite(u.used) && u.used >= 0
        ? `${(u.used / 1024 ** 3).toFixed(1)} / ${(u.total / 1024 ** 3).toFixed(1)} GB${u.error ? "（缓存）" : ""}`
        : "流量待同步";
    const fee =
      i.billing?.amount != null
        ? ` · ${Number(i.billing.amount).toFixed(2)} ${i.billing.currency}${i.billing.stale ? "（缓存）" : ""}`
        : "";
    lines.push(
      `\n${regionFlag(i.region)} ${clip(i.name, 24)} · ${status}\n${flow}${fee}`.trim(),
    );
    if (i.error)
      lines.push("异常：" + clip(String(i.error).replace(/\s+/g, " "), 70));
    else if (i.decision && i.decision !== "none")
      lines.push(
        "计划" + operationTitle(i.source, i.decision) + "（等待执行）",
      );
  }
  if (items.length > 5)
    lines.push("其余 " + (items.length - 5) + " 台请在面板查看");
  return lines.join("\n");
}
export function dailySummary(
  items: any[],
  accounts: any[],
  billingEnabled = true,
) {
  const lines = [
    items.length +
      " 台 · 运行 " +
      items.filter((i) => i.status === "Running").length +
      " · 已停止 " +
      items.filter((i) => i.status === "Stopped").length,
  ];
  const bills = new Map(accounts.map((b) => [b.accountId, b]));
  const poolKey = (i: any) =>
    JSON.stringify([
      i.accountId,
      i.usage?.pool ||
        (i.region?.startsWith("cn-") && i.region !== "cn-hongkong"
          ? "china"
          : "international"),
    ]);
  const pools = new Map<string, any>();
  for (const i of items) {
    if (!i.accountId) continue;
    const key = poolKey(i),
      previous = pools.get(key);
    if (
      !pools.has(key) ||
      Number(i.usage?.at || 0) >= Number(previous?.at || 0)
    )
      pools.set(key, i.usage);
  }
  for (const i of items.slice(0, 5)) {
    const usage = i.accountId ? pools.get(poolKey(i)) : i.usage;
    const used = usage?.used,
      total = usage?.total;
    const flow =
      used != null && Number.isFinite(used) && used >= 0
        ? (used / 1024 ** 3).toFixed(1) +
          (total != null && Number.isFinite(total) && total > 0
            ? " / " + (total / 1024 ** 3).toFixed(1)
            : "") +
          " GB" +
          (usage.error ? "（缓存）" : "")
        : "待同步";
    const details = ["共享流量 " + flow];
    if (billingEnabled) {
      if (i.billing?.amount != null)
        details.push(
          "费用 " +
            i.billing.amount.toFixed(2) +
            " " +
            i.billing.currency +
            (i.billing.stale ? "（缓存）" : ""),
        );
      else details.push("费用待同步");
      const bill = bills.get(i.accountId),
        v = bill?.balance?.availableAmount;
      details.push(
        "余额 " +
          (v != null && v !== "" && Number.isFinite(Number(v))
            ? Number(v).toFixed(2) +
              " " +
              (bill.balance.currency || bill.currency) +
              (bill.balanceError ? "（缓存）" : "")
            : "待同步"),
      );
    }
    lines.push(
      "\n" +
        (regionFlag(i.region) ? regionFlag(i.region) + " " : "") +
        clip(i.name, 24) +
        " · " +
        (i.status === "Running"
          ? "运行"
          : i.status === "Stopped"
            ? "停止"
            : "状态待同步"),
      details.join(" · "),
    );
  }
  if (items.length > 5)
    lines.push("其余 " + (items.length - 5) + " 台请在面板查看");
  return lines.join("\n");
}
const sampleItems = [
  {
    accountId: "sample-main",
    accountName: "香港生产环境",
    name: "香港 Web",
    region: "cn-hongkong",
    status: "Running",
    usage: { used: 64.8 * 1024 ** 3, total: 200 * 1024 ** 3 },
    rule: { paused: false },
    billing: { amount: 48, currency: "CNY" },
  },
  {
    name: "备份服务器",
    accountId: "sample-main",
    accountName: "香港生产环境",
    region: "cn-hongkong",
    status: "Stopped",
    usage: { used: 64.8 * 1024 ** 3, total: 200 * 1024 ** 3 },
    rule: { paused: false },
    billing: { amount: 24, currency: "CNY" },
  },
  {
    name: "新加坡 API",
    accountId: "sample-intl",
    accountName: "新加坡应用",
    region: "ap-southeast-1",
    status: "Running",
    usage: { used: 182.4 * 1024 ** 3, total: 200 * 1024 ** 3 },
    rule: { paused: false },
    billing: { amount: 4.5, currency: "USD" },
  },
];
export const notificationExamples: {
  id: string;
  label: string;
  hint: string;
  item: NotificationMessage;
}[] = [
  {
    id: "keepalive",
    label: "保活开机",
    hint: "每次保活启动确认成功后推送一条；正常运行不推送",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: operationTitle("keepalive", "start"),
      instance: { name: "香港 Web", region: "cn-hongkong" },
      message: "已确认实例运行",
    },
  },
  {
    id: "threshold",
    label: "流量告警",
    hint: "持续超限只提醒一次；流量恢复后再次超限会重新提醒",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "流量阈值告警",
      level: "warning",
      instance: {
        name: "香港 Web",
        region: "cn-hongkong",
        usage: { used: 181 * 1024 ** 3, total: 200 * 1024 ** 3 },
      },
      message: "已达到 90%，准备关机",
    },
  },
  {
    id: "traffic",
    label: "流量关机",
    hint: "每次流量保护关机确认成功后推送一条；勾选流量告警时另发一条",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: operationTitle("traffic", "stop"),
      instance: {
        name: "香港 Web",
        region: "cn-hongkong",
        usage: { used: 181 * 1024 ** 3, total: 200 * 1024 ** 3 },
      },
      message: "已确认实例停止",
    },
  },
  {
    id: "traffic-recovery",
    label: "流量保护恢复",
    hint: "每次解除流量保护时推送一条；自动开机仍受保活、恢复选项与定时规则限制",
    item: {
      at: "2026-11-01T00:00:00Z",
      title: "流量保护恢复",
      instance: {
        name: "香港 Web",
        region: "cn-hongkong",
        usage: { used: 0, total: 200 * 1024 ** 3 },
      },
      message: "流量已低于阈值，按保活与定时规则重新检查",
    },
  },
  {
    id: "schedule",
    label: "定时开关机",
    hint: "每次定时开机或关机确认成功后推送一条",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: operationTitle("schedule", "stop"),
      instance: { name: "备份服务器", region: "cn-hongkong" },
      message: "已确认实例停止",
    },
  },
  {
    id: "manual",
    label: "手动开关机",
    hint: "每次手动开机或关机确认成功后推送一条",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: operationTitle("manual", "start"),
      instance: { name: "香港 Web" },
      message: "已确认实例运行",
    },
  },
  {
    id: "error",
    label: "检测异常",
    hint: "新的查询异常通知一次；相同异常不重复推送",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "检测异常",
      level: "error",
      instance: { name: "香港 Web" },
      message: "实例状态查询失败：AccessDenied，请检查 RAM 权限",
    },
  },
  {
    id: "billing",
    label: "账单查询异常",
    hint: "账单或余额查询失败时通知一次，保留缓存；相同异常不重复推送",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "账单查询异常",
      level: "error",
      instance: { name: "香港 Web", region: "cn-hongkong" },
      message: "余额：请求超时；已保留上次成功数据，请在面板查看详情",
    },
  },
  {
    id: "recovery",
    label: "检测恢复",
    hint: "同一查询异常恢复时通知",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "检测恢复",
      instance: { name: "香港 Web" },
      message: "查询已恢复，按当前规则继续监控",
    },
  },
  {
    id: "operation-error",
    label: "开关机异常",
    hint: "每次开关机失败或结果需核对时推送一条",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "保活开机",
      level: "error",
      type: "operation-error",
      instance: { name: "香港 Web" },
      message: "启动失败：库存不足，将按检测间隔重试",
    },
  },
  {
    id: "status",
    label: "实例状态变化",
    hint: "检测到实例状态发生变化时推送一条；状态未变化不推送",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "实例状态变化",
      instance: { name: "香港 Web" },
      message: "Running → Stopped",
    },
  },
  {
    id: "billing-recovery",
    label: "账单查询恢复",
    hint: "账单或余额查询由异常恢复正常时推送一条",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "账单查询恢复",
      instance: { name: "香港 Web" },
      message: "账单与余额已成功刷新",
    },
  },
  {
    id: "cycle",
    label: "每轮汇总",
    hint: "每次完整检测完成后推送一条；手动刷新也会触发",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "检测完成",
      kind: "cycle",
      message: cycleDetails(sampleItems),
    },
  },
  {
    id: "daily",
    label: "每日汇总",
    hint: "每天按设定时间和时区推送一条；最多列出 5 台实例，显示状态、共享流量、费用和余额",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "Aliyun 实例日报 2026-10-14",
      kind: "report",
      message: dailySummary(sampleItems, [
        {
          accountId: "sample-main",
          accountName: "香港生产环境",
          currency: "CNY",
          balance: { availableAmount: 128.5 },
        },
        {
          accountId: "sample-intl",
          accountName: "新加坡应用",
          currency: "USD",
          balance: { availableAmount: 36.8 },
        },
      ]),
    },
  },
  {
    id: "test",
    label: "测试通知",
    hint: "点击「测试通知」后使用已保存的 Telegram 配置发送",
    item: {
      at: "2026-10-14T11:00:00Z",
      title: "TG 通知测试",
      message: "连接正常，后续按勾选的通知类型推送",
    },
  },
];
