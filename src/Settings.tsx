import {
  notificationChoices,
  notificationSelection,
} from "../shared/notification-preferences";
import type { NotificationType } from "../shared/notification-preferences";
import {
  formatNotification,
  notificationIcon,
  notificationExamples,
} from "../shared/notifications";
import { Settings as HeadingSettingsIcon } from "lucide-react";
import Select from "./components/ui/Select";
import TimePicker from "./components/ui/TimePicker";
import TimezoneSelect from "./components/ui/TimezoneSelect";
import {
  api,
  date,
  Empty,
  ErrorBox,
  Field,
  Switch,
  useData,
  usePanel,
} from "./lib";
import { useState } from "react";
import type { Settings } from "../shared/types";
import { PendingButton } from "./components/ui/PendingButton";
import {
  DataRegion,
  LoadingTable,
  PageLoading,
} from "./components/ui/DataRegion";
const notificationFields = [
  "telegramToken",
  "telegramChatId",
  "telegramEnabled",
  "events",
  "apiBase",
] as const;
export default function SettingsPage() {
  const p = usePanel();
  const [draft, setS] = useState<Settings>();
  const s = draft ?? p.settings;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [example, setExample] = useState("keepalive");
  const [hours, setHours] = useState(720);
  const outbox = useData<{ items: any[]; at: number }>(
    "/notifications",
    p.revision,
  );
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!s || busy) return;
    setBusy(true);
    setError("");
    try {
      const clean = Object.fromEntries(
        notificationFields.map((k) => [
          k,
          k === "events" ? notificationSelection(s) : s.notifications[k],
        ]),
      );
      const { keepAliveDefault: _, ...editable } = s;
      setS(
        await api("/settings", { ...editable, notifications: clean }, "PUT"),
      );
      p.refresh();
      p.notice("设置已保存");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!s)
    return p.initialLoading ? (
      <PageLoading page="settings" />
    ) : (
      <Empty>暂时无法读取设置，请刷新重试</Empty>
    );
  const n = s.notifications;
  const selected = notificationSelection(s);
  const dailyEnabled = selected.includes("daily");
  const preview = notificationExamples.find((v) => v.id === example)!;
  const selectNotifications = (events: NotificationType[]) => {
    setS({
      ...s,
      dailyReport: events.includes("daily"),
      notifications: { ...n, events },
    });
  };
  const toggleNotification = (type: NotificationType, checked: boolean) =>
    selectNotifications(
      checked ? [...selected, type] : selected.filter((v) => v !== type),
    );
  const setN = (key: string, value: string | boolean) =>
    setS({ ...s, notifications: { ...n, [key]: value } });
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <h1>
            <HeadingSettingsIcon size={22} />
            设置
          </h1>
        </div>
      </div>
      <form id="panel-settings" className="form-stack" onSubmit={save}>
        <section className="form-panel form-stack">
          <h2>监控设置</h2>
          <div className="form-grid">
            <Field label="检测间隔">
              <Select
                value={s.checkInterval}
                onChange={(e) => setS({ ...s, checkInterval: +e.target.value })}
              >
                {[60, 300, 900, 1800, 3600].map((v) => (
                  <option key={v} value={v}>
                    {v / 60} 分钟
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="账单刷新间隔">
              <Select
                value={s.billingInterval}
                onChange={(e) =>
                  setS({ ...s, billingInterval: +e.target.value })
                }
              >
                {[300, 900, 3600, 21600, 86400].map((v) => (
                  <option key={v} value={v}>
                    {v < 3600 ? v / 60 + " 分钟" : v / 3600 + " 小时"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.billingEnabled}
              onChange={(e) => setS({ ...s, billingEnabled: e.target.checked })}
            />
            读取账单和余额
          </label>
          <div className="form-actions">
            <PendingButton type="submit" busy={busy} pendingLabel="正在保存">
              保存监控设置
            </PendingButton>
          </div>
        </section>
        <section className="form-panel form-stack">
          <div className="section-heading">
            <h2>Telegram 通知</h2>
            <Switch
              checked={n.telegramEnabled}
              onChange={(v) => setN("telegramEnabled", v)}
              label="启用 Telegram"
            />
          </div>
          <div className="form-grid">
            <Field label="Bot Token">
              <input
                type="password"
                autoComplete="off"
                placeholder={
                  n.telegramConfigured ? "已配置，留空保留" : "输入 Bot Token"
                }
                value={n.telegramToken}
                onChange={(e) => setN("telegramToken", e.target.value)}
              />
            </Field>
            <Field label="Chat ID">
              <input
                value={n.telegramChatId}
                onChange={(e) => setN("telegramChatId", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Telegram API 地址">
            <input
              type="url"
              required
              value={n.apiBase}
              onChange={(e) => setN("apiBase", e.target.value)}
            />
          </Field>
          <fieldset
            className="notification-types"
            aria-labelledby="notification-types-title"
          >
            <legend>
              <span id="notification-types-title">通知类型</span>
              <span className="notification-selection-actions">
                <button
                  type="button"
                  className="button small"
                  disabled={
                    busy || selected.length === notificationChoices.length
                  }
                  onClick={() =>
                    selectNotifications(notificationChoices.map((v) => v.value))
                  }
                >
                  全选
                </button>
                <button
                  type="button"
                  className="button small"
                  disabled={busy || selected.length === 0}
                  onClick={() => selectNotifications([])}
                >
                  取消全选
                </button>
              </span>
            </legend>
            <div className="notification-type-grid">
              {notificationChoices.map((v) => (
                <label key={v.value} className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(v.value)}
                    onChange={(e) =>
                      toggleNotification(v.value, e.target.checked)
                    }
                  />
                  <span>{v.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div
            className="form-grid notification-report-settings"
            data-enabled={dailyEnabled}
          >
            <Field label="日报时间">
              <TimePicker
                disabled={!dailyEnabled}
                value={s.reportTime}
                onChange={(value) => setS({ ...s, reportTime: value })}
              />
            </Field>
            <Field label="日报时区">
              <TimezoneSelect
                disabled={!dailyEnabled}
                value={s.timezone}
                onChange={(value) => setS({ ...s, timezone: value })}
              />
            </Field>
          </div>
          <section className="notification-preview">
            <div className="section-heading">
              <h2>通知示例</h2>
              <Select
                aria-label="消息类型"
                value={example}
                onChange={(e) => setExample(e.target.value)}
              >
                {notificationExamples.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </div>
            <div
              className="notification-example"
              dangerouslySetInnerHTML={{
                __html: formatNotification(preview.item, true),
              }}
            />
          </section>
          <ErrorBox error={error} />
          <div className="form-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                try {
                  const r = await api("/notifications/test", {});
                  p.notice(
                    r.channels.length
                      ? "TG 测试消息已入队"
                      : "请先保存 Token、Chat ID 并启用 TG",
                  );
                  p.refresh();
                } catch (e) {
                  p.notice((e as Error).message, true);
                }
              }}
            >
              测试通知
            </button>
            <PendingButton type="submit" busy={busy} pendingLabel="正在保存">
              保存设置
            </PendingButton>
          </div>
        </section>
      </form>
      <section className="form-panel form-stack">
        <h2>登录有效期</h2>
        <div className="form-stack">
          <div className="row session-row">
            <Select
              aria-label="续期时长"
              value={hours}
              onChange={(e) => setHours(+e.target.value)}
            >
              {[
                [12, "12 小时"],
                [24, "1 天"],
                [168, "7 天"],
                [720, "30 天"],
                [2160, "90 天"],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <button
              className="button"
              onClick={async () => {
                try {
                  const r = await api("/session", { hours });
                  p.notice("会话有效至 " + date(r.expires));
                } catch (e) {
                  p.notice((e as Error).message, true);
                }
              }}
            >
              续期登录
            </button>
          </div>
        </div>
      </section>
      <div className="section-heading">
        <h2>最近通知</h2>
      </div>
      <ErrorBox error={outbox.error} />
      <DataRegion
        pending={outbox.initialLoading}
        placeholder={<LoadingTable columns={["时间", "通知", "投递状态"]} />}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>通知</th>
                <th>投递状态</th>
              </tr>
            </thead>
            <tbody>
              {outbox.data?.items.slice(0, 5).map((r) => (
                <tr key={r.id}>
                  <td>{date(r.at)}</td>
                  <td>
                    <span aria-hidden="true">{notificationIcon(r)}</span>{" "}
                    {r.title}
                    {r.error && (
                      <div className="subline danger-text">{r.error}</div>
                    )}
                  </td>
                  <td>
                    {r.status === "sent"
                      ? "已发送"
                      : r.status === "failed"
                        ? "失败"
                        : r.status === "skipped"
                          ? "已跳过"
                          : "等待发送"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!outbox.data?.items.length && <Empty>暂无 TG 通知</Empty>}
        </div>
      </DataRegion>
    </div>
  );
}
