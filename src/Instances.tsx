import { regionName } from "../shared/regions";
import { SearchInput } from "./components/ui/SearchInput";
import { ActionMenu } from "./components/ui/ActionMenu";
import { CopyText } from "./components/ui/CopyText";
import { Cloud, Plus, Pencil, ShieldCheck, Clock3, Trash2 } from "lucide-react";
import ConnectionDialog from "./Connections";
import Billing, { money } from "./Billing";
import { Traffic } from "./Resources";
import Select from "./components/ui/Select";
import TimePicker from "./components/ui/TimePicker";
import TimezoneSelect from "./components/ui/TimezoneSelect";
import { useMemo, useState } from "react";
import {
  Activity,
  Play,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
} from "lucide-react";
import type { Instance, Rule } from "../shared/types";
import {
  api,
  bytes,
  date,
  Empty,
  ErrorBox,
  Field,
  key,
  RefreshTime,
  Switch,
  target,
  usePanel,
} from "./lib";
import { Modal } from "./components/ui/Modal";
import { PendingButton } from "./components/ui/PendingButton";
import { RefreshButton } from "./components/ui/RefreshButton";
import { DataRegion, Skeleton } from "./components/ui/DataRegion";

const statuses: Record<string, string> = {
  Running: "运行中",
  Stopped: "已停止",
  Starting: "启动中",
  Stopping: "停止中",
  Pending: "准备中",
  Disabled: "不可用",
  Resetting: "重置中",
  Upgrading: "升级中",
  Unknown: "未知",
};
export default function Instances() {
  const p = usePanel();
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [editing, setEditing] = useState<{
    instance: Instance;
    kind: "traffic" | "schedule";
  }>();
  const [operation, setOperation] = useState<{
    items: Instance[];
    action: string;
  }>();
  const [adding, setAdding] = useState(false);
  const [connection, setConnection] = useState<Instance>();
  const [removing, setRemoving] = useState<Instance>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{
    kind: "traffic" | "billing";
    instance: Instance;
  }>();
  const items = useMemo(
    () =>
      p.snapshot.items.filter((i) =>
        [i.name, i.id, i.region, ...i.ip]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [p.snapshot.items, search],
  );
  const checks = items
    .map((i) => Date.parse(i.rule.lastCheck || ""))
    .filter(Number.isFinite);
  const lastCheck = checks.length ? Math.min(...checks) : undefined;
  const selected = items.filter((i) => chosen.includes(key(i)));
  const running = items.filter((i) => i.status === "Running").length,
    alive = items.filter((i) => i.effectiveKeepAlive).length;
  const refresh = async () => {
    setBusy(true);
    try {
      await api("/refresh", { check: true });
      p.refresh();
    } catch (e) {
      p.notice((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (i: Instance, v: boolean) => {
    try {
      await api("/keepalive", { target: target(i), keepAlive: v }, "PUT");
      p.refresh();
      p.notice(i.name + (v ? " 保活已开启" : " 保活已关闭"));
    } catch (e) {
      p.notice((e as Error).message, true);
    }
  };
  return (
    <>
      <div className="page-heading instances-heading">
        <div>
          <h1>
            <Cloud size={22} />
            Aliyun 实例
          </h1>
        </div>
        <div className="row">
          <RefreshButton
            text="刷新"
            title="更新当前筛选实例的数据，并检查已启用的保活、流量保护和定时规则"
            onClick={refresh}
            loading={busy || p.loading || p.snapshot.refreshing}
          />
          <button className="button primary" onClick={() => setAdding(true)}>
            <Plus size={16} />
            添加实例
          </button>
        </div>
      </div>
      <div className="instances-overview">
        <div className="instance-counts">
          <span>
            实例 <strong>{items.length}</strong>
          </span>
          <span>
            运行中{" "}
            <strong>
              <DataRegion
                inline
                pending={
                  p.snapshot.refreshing &&
                  items.some((i) => i.status === "Unknown")
                }
                placeholder={<Skeleton className="skeleton-count" />}
              >
                {running}
              </DataRegion>
            </strong>
          </span>
          <span>
            保活开启 <strong>{alive}</strong>
          </span>
        </div>
        <div className="instance-times muted">
          <RefreshTime
            value={p.snapshot.at}
            entries={[
              { label: "实例数据", value: p.snapshot.at },
              { label: "规则检查", value: lastCheck },
            ]}
          />
        </div>
      </div>
      {p.snapshot.errors.length > 0 && (
        <ErrorBox error={p.snapshot.errors.join("；")} />
      )}
      <div className="toolbar instances-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索名称、IP、地域…"
        />
        <span className="instances-reset muted">
          流量额度每月 1 日 00:00（北京时间）重置 · 距下次 {resetCountdown()}
        </span>
        {selected.length > 0 && (
          <div className="row">
            <span className="muted">已选 {selected.length} 台</span>
            {["start", "stop"].map((action) => (
              <button
                className="button small"
                key={action}
                onClick={() => setOperation({ items: selected, action })}
              >
                {action === "start"
                  ? "批量开机"
                  : action === "stop"
                    ? "批量关机"
                    : "批量重启"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="table-wrap instances-table">
        <table>
          <thead>
            <tr>
              <th>
                <label className="selection-box">
                  <input
                    type="checkbox"
                    aria-label="选择全部实例"
                    checked={
                      items.length > 0 &&
                      items.every((i) => chosen.includes(key(i)))
                    }
                    onChange={(e) =>
                      setChosen(e.target.checked ? items.map(key) : [])
                    }
                  />
                </label>
              </th>
              <th>实例</th>
              <th>状态</th>
              <th>公网 IP</th>
              <th>本月流量</th>
              <th className="keep-column">
                <Activity size={14} />
                保活
              </th>
              <th className="automation-column">流量保护</th>
              <th className="automation-column">定时关机</th>
              <th>本月费用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={key(i)}>
                <td>
                  <label className="selection-box">
                    <input
                      type="checkbox"
                      aria-label={"选择 " + i.name}
                      checked={chosen.includes(key(i))}
                      onChange={(e) =>
                        setChosen((v) =>
                          e.target.checked
                            ? [...v, key(i)]
                            : v.filter((x) => x !== key(i)),
                        )
                      }
                    />
                  </label>
                </td>
                <td data-label="实例">
                  <strong title={i.name}>{i.name}</strong>
                  <div className="subline" title={i.region}>
                    {regionName(i.region)}
                  </div>
                </td>
                <td data-label="状态">
                  <DataRegion
                    inline
                    pending={p.snapshot.refreshing && i.status === "Unknown"}
                    placeholder={<Skeleton />}
                  >
                    <span
                      className={
                        "status " +
                        (i.status === "Running"
                          ? "running"
                          : i.status === "Stopped"
                            ? "stopped"
                            : "")
                      }
                    >
                      {statuses[i.status] || i.status}
                    </span>
                  </DataRegion>
                  {i.job && (
                    <div className="subline">
                      {i.job.status === "attention" ? "需核对" : "操作处理中"}
                    </div>
                  )}
                </td>
                <td data-label="公网 IP" className="mono">
                  <DataRegion
                    inline
                    pending={
                      p.snapshot.refreshing &&
                      i.status === "Unknown" &&
                      !i.ip.length
                    }
                    placeholder={<Skeleton />}
                  >
                    {i.ip.length
                      ? i.ip.map((ip) => (
                          <div key={ip}>
                            <CopyText
                              text={ip}
                              toast={(message, type) =>
                                p.notice(message, type === "error")
                              }
                            />
                          </div>
                        ))
                      : "—"}
                  </DataRegion>
                </td>
                <td data-label="本月流量">
                  <button
                    className="usage-trigger"
                    aria-label={i.name + " 流量详情"}
                    title={"刷新时间 " + date(i.usage?.at)}
                    onClick={() => setDetail({ kind: "traffic", instance: i })}
                  >
                    <Usage instance={i} />
                  </button>
                </td>
                <td data-label="保活" className="keep-column">
                  <div className="row">
                    <Switch
                      checked={i.effectiveKeepAlive}
                      onChange={(v) => toggle(i, v)}
                      label={i.name + " 保活"}
                    />
                    <span>{i.effectiveKeepAlive ? "开启" : "关闭"}</span>
                  </div>
                </td>
                <td data-label="流量保护" className="automation-column">
                  <ProtectionState
                    instance={i}
                    kind="traffic"
                    onEdit={(kind) => setEditing({ instance: i, kind })}
                  />
                </td>
                <td data-label="定时关机" className="automation-column">
                  <ProtectionState
                    instance={i}
                    kind="schedule"
                    onEdit={(kind) => setEditing({ instance: i, kind })}
                  />
                </td>
                <td data-label="本月费用" className="instance-fee">
                  <button
                    className="fee-trigger"
                    aria-label={i.name + " 账单与余额"}
                    onClick={() => setDetail({ kind: "billing", instance: i })}
                  >
                    <DataRegion
                      inline
                      pending={!i.billing && p.snapshot.refreshing}
                      placeholder={<Skeleton />}
                    >
                      {money(
                        i.billing?.amount,
                        i.billing?.currency ||
                          (p.accounts.find((a) => a.id === i.accountId)
                            ?.site === "international"
                            ? "USD"
                            : "CNY"),
                      )}
                    </DataRegion>
                  </button>
                  {i.billing?.stale && <div className="subline">待刷新</div>}
                </td>
                <td data-label="操作">
                  <ActionMenu label={i.name}>
                    <div className="menu-power-actions">
                      <button
                        role="menuitem"
                        disabled={!!i.job || i.status !== "Stopped"}
                        onClick={() =>
                          setOperation({ items: [i], action: "start" })
                        }
                      >
                        <Play />
                        <span>启动</span>
                      </button>
                      <button
                        role="menuitem"
                        disabled={!!i.job || i.status !== "Running"}
                        onClick={() =>
                          setOperation({ items: [i], action: "stop" })
                        }
                      >
                        <Square />
                        <span>停止</span>
                      </button>
                    </div>
                    <hr />
                    <button
                      role="menuitem"
                      onClick={() =>
                        setEditing({ instance: i, kind: "traffic" })
                      }
                    >
                      <ShieldCheck />
                      <span>流量保护</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() =>
                        setEditing({ instance: i, kind: "schedule" })
                      }
                    >
                      <Clock3 />
                      <span>定时关机</span>
                    </button>
                    <button role="menuitem" onClick={() => setConnection(i)}>
                      <Pencil />
                      <span>编辑实例</span>
                    </button>
                    {i.job?.status === "attention" && (
                      <button
                        role="menuitem"
                        onClick={async () => {
                          try {
                            await api("/jobs/" + i.job!.id + "/recheck", {});
                            p.refresh();
                            p.notice("已重新核对状态");
                          } catch (e) {
                            p.notice((e as Error).message, true);
                          }
                        }}
                      >
                        <RefreshCw />
                        <span>核对操作状态</span>
                      </button>
                    )}
                    <hr />
                    <button
                      role="menuitem"
                      className="danger-text"
                      disabled={!!i.job}
                      onClick={() => setRemoving(i)}
                    >
                      <Trash2 />
                      <span>移除监控</span>
                    </button>
                  </ActionMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <Empty>
            {!p.accounts.length ? (
              <>
                <h2>还没有添加实例</h2>
                <p>使用 AccessKey ID 和 Secret 发现并选择已有 ECS 实例</p>
                <button className="button" onClick={() => setAdding(true)}>
                  添加实例
                </button>
              </>
            ) : p.snapshot.refreshing ? (
              "正在发现各地域实例…"
            ) : (
              "没有匹配的实例，可刷新或调整筛选条件"
            )}
          </Empty>
        )}
      </div>
      {editing && (
        <RuleDialog {...editing} onClose={() => setEditing(undefined)} />
      )}
      {operation && (
        <OperationDialog
          {...operation}
          onClose={() => setOperation(undefined)}
        />
      )}{" "}
      {detail && (
        <Modal
          title={
            (detail.kind === "traffic" ? "流量统计" : "实例账单") +
            " · " +
            detail.instance.name
          }
          description={regionName(detail.instance.region)}
          wide
          className="resource-modal"
          backdropClassName="resource-backdrop"
          onClose={() => setDetail(undefined)}
        >
          {detail.kind === "traffic" ? (
            <Traffic instance={detail.instance} />
          ) : (
            <Billing
              accountId={detail.instance.accountId}
              instance={detail.instance}
            />
          )}
        </Modal>
      )}
      {adding && <ConnectionDialog onClose={() => setAdding(false)} />}
      {connection && (
        <ConnectionDialog
          account={p.accounts.find((a) => a.id === connection.accountId)}
          instance={connection}
          onClose={() => setConnection(undefined)}
        />
      )}
      {removing && (
        <Modal
          title="移除实例监控"
          onClose={() => setRemoving(undefined)}
          busy={removeBusy}
        >
          <div className="form-stack">
            <p>从面板移除 {removing.name} 的监控配置；云端实例不会关机或删除</p>
            <div className="form-actions">
              <button
                className="button"
                disabled={removeBusy}
                onClick={() => setRemoving(undefined)}
              >
                取消
              </button>
              <PendingButton
                className="button danger"
                busy={removeBusy}
                pendingLabel="正在移除"
                onClick={async () => {
                  setRemoveBusy(true);
                  try {
                    await api("/monitors", target(removing), "DELETE");
                    p.refresh();
                    p.notice("监控已移除");
                    setRemoving(undefined);
                  } catch (e) {
                    p.notice((e as Error).message, true);
                  } finally {
                    setRemoveBusy(false);
                  }
                }}
              >
                确认移除监控
              </PendingButton>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
export function Usage({ instance: i }: { instance: Instance }) {
  const p = usePanel();
  const u = i.usage;
  const ratio = u?.total && u.used != null ? (u.used / u.total) * 100 : null;
  return (
    <DataRegion
      pending={!u && p.snapshot.refreshing}
      placeholder={
        <div className="usage usage-placeholder">
          <Skeleton />
          <Skeleton className="skeleton-meta" />
        </div>
      }
    >
      <div className="usage">
        <div>
          {u?.quota === "none"
            ? "无固定流量配额"
            : `${bytes(u?.used)} / ${bytes(u?.total)}`}
        </div>
        {ratio != null && (
          <>
            <div className="progress">
              <span
                style={{ width: Math.min(100, ratio) + "%" }}
                className={ratio >= 90 ? "warning" : ""}
              />
            </div>
            <small>{ratio.toFixed(1)}%</small>
          </>
        )}
        {u?.error && <small className="danger-text">用量更新失败</small>}
        {!!u?.overflow && (
          <small className="danger-text">超额 {bytes(u.overflow)}</small>
        )}
      </div>
    </DataRegion>
  );
}
function OperationDialog({
  items,
  action,
  onClose,
}: {
  items: Instance[];
  action: string;
  onClose: () => void;
}) {
  const p = usePanel();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stoppedMode, setStoppedMode] = useState<
    "KeepCharging" | "StopCharging"
  >("KeepCharging");
  const label = action === "stop" ? "关机" : "开机";
  const run = async () => {
    if (busy) return;
    setBusy(true);
    const results = await Promise.allSettled(
      items.map((i) =>
        api("/operations", {
          ...target(i),
          action:
            action === "start" && i.rule.hold === "traffic" ? "resume" : action,
          stoppedMode,
        }),
      ),
    );
    const failed = results.flatMap((r, n) =>
      r.status === "rejected" ? [`${items[n].name}: ${r.reason.message}`] : [],
    );
    p.refresh();
    setBusy(false);
    if (failed.length) {
      setError(failed.join("；"));
      if (failed.length < items.length) p.notice("部分操作已提交，其余失败");
    } else {
      p.notice(`${items.length} 台实例${label}已提交`);
      onClose();
    }
  };
  return (
    <Modal
      title={label + (items.length > 1 ? ` ${items.length} 台实例` : "")}
      onClose={onClose}
      busy={busy}
    >
      <div className="form-stack">
        <p>{items.map((i) => i.name).join("、")}</p>
        {action === "stop" ? (
          <p>关机后保存手动停机保护，保活和定时开机不会自动拉起实例</p>
        ) : action === "start" ? (
          <>
            <p>
              开机前检查流量、到期时间与定时规则；确认运行后解除手动停机保护
            </p>
          </>
        ) : (
          <p>按当前规则检查并恢复开机</p>
        )}
        {action === "stop" && (
          <StopMode value={stoppedMode} onChange={setStoppedMode} />
        )}
        <ErrorBox error={error} />
        <div className="form-actions">
          <button className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <PendingButton busy={busy} pendingLabel="正在提交" onClick={run}>
            确认{label}
          </PendingButton>
        </div>
      </div>
    </Modal>
  );
}
function StopMode({
  value,
  onChange,
}: {
  value: "KeepCharging" | "StopCharging";
  onChange: (v: "KeepCharging" | "StopCharging") => void;
}) {
  return (
    <Field
      label="停机模式"
      hint={
        value === "KeepCharging"
          ? "保留计算资源和公网 IP，停机后继续计费"
          : "仅符合条件的按量实例生效；可能释放计算资源和公网 IP，磁盘仍计费"
      }
    >
      <Select
        value={value}
        onChange={(e) =>
          onChange(e.target.value as "KeepCharging" | "StopCharging")
        }
      >
        <option value="KeepCharging">普通停机（保留资源）</option>
        <option value="StopCharging">节省停机（释放计算资源）</option>
      </Select>
    </Field>
  );
}
function RuleDialog({
  instance: i,
  kind,
  onClose,
}: {
  instance: Instance;
  kind: "traffic" | "schedule";
  onClose: () => void;
}) {
  const p = usePanel(),
    title = kind === "traffic" ? "流量保护" : "定时关机";
  const [r, setR] = useState<Rule>({
    ...i.rule,
    scheduleStopEnabled: true,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (changes: Partial<Rule>) => setR((v) => ({ ...v, ...changes }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const fields =
      kind === "traffic"
        ? [
            "thresholdEnabled",
            "thresholdPercent",
            "thresholdUnit",
            "thresholdGiB",
            "thresholdAction",
            "autoRecover",
            "stoppedMode",
          ]
        : [
            "scheduleEnabled",
            "scheduleStopEnabled",
            "start",
            "stop",
            "timezone",
            "stoppedMode",
          ];
    try {
      await api(
        "/rules/" + kind,
        {
          target: target(i),
          rule: Object.fromEntries(fields.map((k) => [k, r[k as keyof Rule]])),
        },
        "PUT",
      );
      p.refresh();
      p.notice(i.name + " " + title + "已保存");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={i.name + " · " + title} onClose={onClose} busy={busy}>
      <form className="form-stack" onSubmit={save}>
        {kind === "traffic" ? (
          <>
            <Usage instance={i} />
            <small className="muted">
              使用该账号的
              {i.region.startsWith("cn-") && i.region !== "cn-hongkong"
                ? "中国内地"
                : "非中国内地"}
              流量池，包含其他实例及云产品用量
            </small>
            <label className="check-row">
              <input
                type="checkbox"
                checked={r.thresholdEnabled}
                onChange={(e) => set({ thresholdEnabled: e.target.checked })}
              />
              启用流量保护
            </label>
            <div className="form-grid">
              <Field label="阈值单位">
                <Select
                  disabled={!r.thresholdEnabled}
                  value={r.thresholdUnit || "percent"}
                  onChange={(e) =>
                    set({
                      thresholdUnit: e.target.value as Rule["thresholdUnit"],
                    })
                  }
                >
                  <option value="percent">流量额度百分比</option>
                  <option value="gib">流量 GB</option>
                </Select>
              </Field>
              <Field
                label={r.thresholdUnit === "gib" ? "阈值（GB）" : "阈值（%）"}
              >
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  max={r.thresholdUnit === "gib" ? 1000000 : 100}
                  disabled={!r.thresholdEnabled}
                  required
                  value={
                    r.thresholdUnit === "gib"
                      ? r.thresholdGiB
                      : r.thresholdPercent
                  }
                  onChange={(e) =>
                    set({
                      [r.thresholdUnit === "gib"
                        ? "thresholdGiB"
                        : "thresholdPercent"]: +e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="达到阈值时">
                <Select
                  disabled={!r.thresholdEnabled}
                  value={r.thresholdAction}
                  onChange={(e) =>
                    set({
                      thresholdAction: e.target
                        .value as Rule["thresholdAction"],
                    })
                  }
                >
                  <option value="stop">关机并通知</option>
                  <option value="notify">仅通知，禁止自动开机</option>
                </Select>
              </Field>
              <StopMode
                value={r.stoppedMode || "KeepCharging"}
                onChange={(v) => set({ stoppedMode: v })}
              />
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                disabled={!r.thresholdEnabled}
                checked={!!r.autoRecover}
                onChange={(e) => set({ autoRecover: e.target.checked })}
              />
              用量恢复安全后自动解除流量保护（含月初重置）
            </label>
            {r.hold === "traffic" && (
              <div className="info-box">
                流量保护已触发；用量恢复安全后可通过实例的“启动”操作恢复
              </div>
            )}
          </>
        ) : (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={r.scheduleEnabled}
                onChange={(e) => set({ scheduleEnabled: e.target.checked })}
              />
              启用每日定时开关机
            </label>
            <div className="form-grid">
              <Field label="开机时间">
                <TimePicker
                  disabled={!r.scheduleEnabled}
                  value={r.start}
                  onChange={(value) => set({ start: value })}
                />
              </Field>
              <Field label="关机时间">
                <TimePicker
                  disabled={!r.scheduleEnabled}
                  value={r.stop}
                  onChange={(value) => set({ stop: value })}
                />
              </Field>
              <Field label="时区">
                <TimezoneSelect
                  disabled={!r.scheduleEnabled}
                  value={r.timezone}
                  onChange={(value) => set({ timezone: value })}
                />
              </Field>
              <StopMode
                value={r.stoppedMode || "KeepCharging"}
                onChange={(value) => set({ stoppedMode: value })}
              />
            </div>
            <small className="muted">
              关机时段保持停机，保活不会提前开机；到开机时间再检查流量保护和手动停机限制
            </small>
          </>
        )}
        <ErrorBox error={error} />
        <div className="form-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <PendingButton type="submit" busy={busy} pendingLabel="正在保存">
            保存
          </PendingButton>
        </div>
      </form>
    </Modal>
  );
}
function ProtectionState({
  instance: i,
  kind,
  onEdit,
}: {
  instance: Instance;
  kind: "traffic" | "schedule";
  onEdit: (kind: "traffic" | "schedule") => void;
}) {
  const r = i.rule;
  const threshold =
    r.thresholdUnit === "gib"
      ? r.thresholdGiB + " GB"
      : r.thresholdPercent + "%";
  return (
    <div className="protection-state">
      {kind === "traffic" && r.thresholdEnabled && (
        <button
          type="button"
          className="rule-chip"
          aria-label={i.name + " 编辑流量保护"}
          title={
            "本月流量达到 " +
            threshold +
            (r.thresholdAction === "stop"
              ? " 时关机并通知"
              : " 时通知，禁止自动开机")
          }
          onClick={() => onEdit("traffic")}
        >
          <ShieldCheck size={13} />
          <span>
            {threshold} · {r.thresholdAction === "stop" ? "关机" : "通知"}
          </span>
        </button>
      )}
      {kind === "schedule" && r.scheduleEnabled && (
        <button
          type="button"
          className="rule-chip"
          aria-label={i.name + " 编辑定时关机"}
          title={
            r.timezone +
            " · 开机 " +
            r.start +
            " / 关机 " +
            r.stop +
            (i.schedule
              ? " · 下次" +
                (i.schedule.nextAction === "start" ? "开机 " : "关机 ") +
                date(i.schedule.nextAt)
              : "")
          }
          onClick={() => onEdit("schedule")}
        >
          <Clock3 size={13} />
          <span>
            {r.start}
            {r.scheduleStopEnabled === false ? " 开机" : "–" + r.stop}
          </span>
        </button>
      )}
      {!(kind === "traffic" ? r.thresholdEnabled : r.scheduleEnabled) && (
        <span className="muted">—</span>
      )}
    </div>
  );
}
function resetCountdown() {
  const local = new Date(Date.now() + 8 * 3600000);
  const reset =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 8 * 3600000;
  const hours = Math.max(1, Math.ceil((reset - Date.now()) / 3600000));
  return Math.floor(hours / 24) + " 天 " + (hours % 24) + " 小时";
}
