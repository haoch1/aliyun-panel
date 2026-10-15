import { actionLabel } from "./actions.ts";
import { displayTrafficUnits } from "./presentation.ts";

const states: Record<string, string> = {
  Running: "运行中",
  Stopped: "已停止",
  Starting: "启动中",
  Stopping: "停止中",
  Unknown: "状态未知",
  queued: "等待提交",
  submitted: "已提交",
  success: "成功",
  failed: "失败",
  attention: "待核对",
  sent: "已发送",
};
const state = (v: string) => states[v] || v || "状态未知";
const gib = (v: number) => (v / 1024 ** 3).toFixed(2) + " GB";

// Older audit entries contain full SDK requests. Format them at display time so
// historical records keep their original error, status and timestamp.
export function logErrorText(value: string | null | undefined): string {
  const text = displayTrafficUnits(value || "");
  const codes = [
    ...new Set(
      text.match(
        /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)\b/g,
      ) || [],
    ),
  ];
  if (!codes.length) return text;
  const errors = codes.map((code) => {
    const reason = ["ENOTFOUND", "EAI_AGAIN"].includes(code)
      ? "接口域名解析失败"
      : code === "ETIMEDOUT"
        ? "接口连接超时"
        : code === "ECONNREFUSED"
          ? "接口连接被拒绝"
          : ["ENETUNREACH", "EHOSTUNREACH"].includes(code)
            ? "接口网络不可达"
            : "接口连接中断";
    return reason + "（" + code + "）";
  });
  const scopes = ["余额", "账单"].filter((scope) =>
    new RegExp("(?:^|[；;])\\s*" + scope + "[：:]").test(text),
  );
  return (
    (scopes.length ? scopes.join("、") + "查询失败：" : "") + errors.join("；")
  );
}

export function resourceLogSummary(r: any) {
  const u = r.usage;
  const validUsed = u?.used != null && Number.isFinite(u.used) && u.used >= 0;
  const validTotal =
    u?.total != null && Number.isFinite(u.total) && u.total > 0;
  const action =
    r.decision === "start" ? "开机" : r.decision === "stop" ? "关机" : "";
  return {
    status: state(r.status),
    traffic: validUsed
      ? (validTotal
          ? (u.used / 1024 ** 3).toFixed(2) + " / " + gib(u.total)
          : gib(u.used)) + (u.error ? "（缓存）" : "")
      : "待同步",
    keepAlive: r.keepAlive ? "开启" : "关闭",
    cost:
      r.billing?.amount != null && Number.isFinite(r.billing.amount)
        ? r.billing.amount.toFixed(2) +
          " " +
          r.billing.currency +
          (r.billing.stale ? "（缓存）" : "")
        : "待同步",
    action: action
      ? (r.source ? actionLabel(r.source + "-" + r.decision) : action) +
        " · " +
        (r.execution ? state(r.execution) : "待执行")
      : "",
    reason: displayTrafficUnits(r.reason || "未记录判断原因"),
    error: logErrorText(r.error || u?.error || r.billing?.error),
  };
}
export function monitorLogTitle(resources: any[]) {
  const actions = resources.filter((r) =>
    ["start", "stop"].includes(r.decision),
  ).length;
  const errors = resources.filter(
    (r) => r.error || r.usage?.error || r.billing?.error,
  ).length;
  return [
    "检测完成",
    resources.length + " 台",
    actions && "计划动作 " + actions,
    errors && "异常 " + errors,
  ]
    .filter(Boolean)
    .join(" · ");
}
export function eventLogSummary(c: any) {
  const parts: string[] = [];
  if (c.before || c.actual)
    parts.push(
      "状态 " + state(c.before) + (c.actual ? " → " + state(c.actual) : ""),
    );
  if (c.phase) parts.push("阶段 " + state(c.phase));
  if (c.stoppedMode)
    parts.push(c.stoppedMode === "KeepCharging" ? "普通停机" : "节省停机");
  if (c.cycle) parts.push("账期 " + c.cycle);
  if (c.availableAmount != null)
    parts.push(
      "余额 " + Number(c.availableAmount).toFixed(2) + " " + (c.currency || ""),
    );
  if (c.balanceStatus) parts.push("余额查询" + state(c.balanceStatus));
  if (c.billStatus) parts.push("账单查询" + state(c.billStatus));
  if (c.rows != null) parts.push(c.rows + " 条账单");
  if (c.attempts != null) parts.push("投递 " + c.attempts + " 次");
  if (c.requestId) parts.push("请求 ID " + c.requestId);
  return parts.join(" · ");
}
