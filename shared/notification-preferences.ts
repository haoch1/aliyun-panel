export const notificationChoices = [
  { value: "keepalive", label: "保活开机" },
  { value: "threshold", label: "流量告警" },
  { value: "traffic", label: "流量关机" },
  { value: "traffic-recovery", label: "流量保护恢复" },
  { value: "schedule", label: "定时开关机" },
  { value: "manual", label: "手动开关机" },
  { value: "operation-error", label: "开关机异常" },
  { value: "status", label: "实例状态变化" },
  { value: "error", label: "检测异常" },
  { value: "recovery", label: "检测恢复" },
  { value: "billing", label: "账单查询异常" },
  { value: "billing-recovery", label: "账单查询恢复" },
  { value: "cycle", label: "每轮汇总" },
  { value: "daily", label: "每日汇总" },
] as const;
export type NotificationType = (typeof notificationChoices)[number]["value"];
export const defaultNotificationTypes: readonly NotificationType[] = [
  "keepalive",
  "traffic",
  "operation-error",
  "error",
  "billing",
  "daily",
];
interface Preferences {
  dailyReport?: boolean;
  notifications: { events?: readonly string[]; mode?: string };
}
interface MessageType {
  type?: string;
  title: string;
  level?: string;
  kind?: string;
}
const validTypes = new Set<string>(notificationChoices.map((v) => v.value));
export function notificationSelection(
  settings: Preferences,
): NotificationType[] {
  const n = settings.notifications;
  if (Array.isArray(n.events))
    return [...new Set(n.events)].filter((v): v is NotificationType =>
      validTypes.has(v),
    );
  if (n.mode === "off") return [];
  const values =
    n.mode === "errors"
      ? ["operation-error", "error", "billing"]
      : notificationChoices
          .map((v) => v.value)
          .filter(
            (v) => v !== "daily" && (v !== "cycle" || n.mode === "always"),
          );
  if (settings.dailyReport) values.push("daily");
  return values as NotificationType[];
}
export function notificationType(item: MessageType): NotificationType {
  if (item.type && validTypes.has(item.type))
    return item.type as NotificationType;
  if (item.kind === "report") return "daily";
  if (item.kind === "cycle") return "cycle";
  const title = item.title;
  if (item.level === "error" && /开机|关机/.test(title))
    return "operation-error";
  if (/账单.*恢复/.test(title)) return "billing-recovery";
  if (/账单|余额/.test(title)) return "billing";
  if (/流量保护恢复/.test(title)) return "traffic-recovery";
  if (/告警|阈值/.test(title)) return "threshold";
  if (/流量.*关机/.test(title)) return "traffic";
  if (/定时/.test(title)) return "schedule";
  if (/手动/.test(title)) return "manual";
  if (/保活/.test(title)) return "keepalive";
  if (/检测恢复/.test(title)) return "recovery";
  if (item.level === "error" || /检测异常/.test(title)) return "error";
  return "status";
}
export function wantsNotification(
  settings: Preferences,
  item: MessageType,
): boolean {
  if (Array.isArray(settings.notifications.events))
    return notificationSelection(settings).includes(notificationType(item));
  // Preserve old stored preferences until their first checkbox-based save
  return (
    settings.notifications.mode !== "off" &&
    (settings.notifications.mode !== "errors" ||
      item.level === "error" ||
      item.kind === "report")
  );
}
