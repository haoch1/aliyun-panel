import { notificationChoices } from "../shared/notification-preferences";
import { sortByName } from "../shared/resource-order";
import { displayTrafficUnits, groupDataTimes } from "../shared/presentation";
import {
  resourceLogSummary,
  monitorLogTitle,
  eventLogSummary,
  logErrorText,
} from "../shared/log-presentation";
import { Modal } from "./components/ui/Modal";
import { RefreshButton } from "./components/ui/RefreshButton";
import { Fragment, useState } from "react";
import { ChevronRight, ScrollText } from "lucide-react";
import Select from "./components/ui/Select";
import { SearchInput } from "./components/ui/SearchInput";
import { actionLabel } from "../shared/actions";
import { api, bytes, date, Empty, ErrorBox, useData, usePanel } from "./lib";
import { DataRegion, LoadingLogs, Skeleton } from "./components/ui/DataRegion";
const levels: Record<string, string> = {
  info: "信息",
  warning: "警告",
  error: "错误",
};
const states: Record<string, string> = {
  Running: "运行中",
  Stopped: "已停止",
  Starting: "启动中",
  Stopping: "停止中",
  Unknown: "未知",
  queued: "等待提交",
  submitted: "已提交",
  success: "成功",
  failed: "失败",
  attention: "需核对",
  sent: "已发送",
};
const sources: Record<string, string> = {
  manual: "手动",
  automatic: "后台检测",
  keepalive: "保活",
  schedule: "定时",
  traffic: "流量保护",
};
const labels: Record<string, string> = {
  endpoint: "接口",
  api: "阿里云 API",
  retryAt: "下次重试",
  method: "请求方法",
  keepAlive: "启用保活",
  checkInterval: "检测间隔（秒）",
  billingEnabled: "自动查询账单",
  billingInterval: "账单刷新间隔（秒）",
  keepAliveDefault: "默认保活",
  telegramEnabled: "Telegram 通知",
  mode: "通知模式",
  events: "通知类型",
  dailyReport: "每日汇总",
  source: "触发方式",
  durationMs: "耗时（毫秒）",
  region: "地域",
  instanceName: "实例名称",
  stoppedMode: "停机模式",
  execution: "执行阶段",
  jobId: "操作编号",
  phase: "执行阶段",
  before: "操作前状态",
  actual: "核实状态",
  expected: "目标状态",
  requestId: "阿里云请求 ID",
  submittedAt: "提交时间",
  completedAt: "完成时间",
  cycle: "账期",
  site: "站点",
  currency: "币种",
  availableAmount: "可用余额",
  balanceStatus: "余额查询",
  billStatus: "账单查询",
  balanceAt: "余额刷新",
  billAt: "账单刷新",
  checkedAt: "最近尝试",
  rows: "账单条目",
  retainedCache: "保留历史数据",
  attempts: "发送次数",
  nextAt: "下次重试",
  notificationId: "通知编号",
  title: "通知标题",
  content: "通知内容",
};
function valueText(k: string, v: any) {
  if (k.endsWith("At")) return date(v);
  if (k === "events" && Array.isArray(v))
    return v.length
      ? v
          .map(
            (type) =>
              notificationChoices.find((c) => c.value === type)?.label || type,
          )
          .join("、")
      : "全部关闭";
  if (k === "mode")
    return (
      (
        {
          events: "动作与异常",
          errors: "仅错误",
          always: "每轮汇总",
          off: "关闭",
        } as Record<string, string>
      )[v] || v
    );
  if (k === "source") return sources[v] || v;
  if (k === "site") return v === "china" ? "国内站" : "国际站";
  if (k === "stoppedMode")
    return v === "KeepCharging" ? "普通停机" : "节省停机";
  if (typeof v === "boolean") return v ? "是" : "否";
  return states[v] || displayTrafficUnits(String(v));
}

function OriginalLogError({ value }: { value: string | undefined }) {
  if (!value || logErrorText(value) === displayTrafficUnits(value)) return null;
  return (
    <details className="log-technical">
      <summary>原始错误</summary>
      <p className="log-content">{value}</p>
    </details>
  );
}

function LogDetails({
  context: c,
  selectedInstance,
}: {
  context: any;
  selectedInstance: string;
}) {
  const resources = sortByName<any>(
    (c.resources || []).filter(
      (r: any) => selectedInstance === "all" || r.id === selectedInstance,
    ),
  );
  return (
    <div className="log-detail-view">
      <dl className="log-metadata">
        {Object.entries(c)
          .filter(
            ([k, v]) => labels[k] && !k.endsWith("At") && v != null && v !== "",
          )
          .map(([k, v]) => (
            <div key={k}>
              <dt>{labels[k]}</dt>
              <dd className={k === "content" ? "log-content" : ""}>
                {valueText(k, v)}
              </dd>
            </div>
          ))}
        {groupDataTimes(
          Object.entries(c)
            .filter(
              ([k, v]) =>
                labels[k] && k.endsWith("At") && v != null && v !== "",
            )
            .map(([k, v]) => ({
              label: labels[k],
              value: v as number | string,
            })),
        ).map((g) => (
          <div key={g.text}>
            <dt>{g.labels.join(" / ")}</dt>
            <dd>{g.text}</dd>
          </div>
        ))}
      </dl>
      {c.rule && (
        <div className="info-box">
          规则：保活 {c.rule.keepAlive !== false ? "开启" : "关闭"} · 流量保护{" "}
          {c.rule.thresholdEnabled
            ? c.rule.thresholdUnit === "gib"
              ? c.rule.thresholdGiB + " GB"
              : c.rule.thresholdPercent + "%"
            : "关闭"}
          {c.rule.scheduleEnabled &&
            " · 定时 " +
              c.rule.start +
              "–" +
              c.rule.stop +
              "（" +
              c.rule.timezone +
              "）"}
        </div>
      )}
      {resources.map((r: any) => (
        <article
          className="log-instance-detail"
          key={r.accountId + r.region + r.id}
        >
          <div className="section-heading">
            <h3>{r.name}</h3>
            <span className={"badge " + (r.status === "Running" ? "ok" : "")}>
              {states[r.status] || r.status}
            </span>
          </div>
          <p className="log-decision">{displayTrafficUnits(r.reason || "")}</p>
          <dl className="log-metadata">
            <div>
              <dt>本月流量</dt>
              <dd>
                {bytes(r.usage?.used)} / {bytes(r.usage?.total)}
              </dd>
            </div>
            <div>
              <dt>保活</dt>
              <dd>
                {r.keepAlive ? "开启" : "关闭"}
                {r.paused ? " · 自动化暂停" : ""}
              </dd>
            </div>
            <div>
              <dt>流量保护</dt>
              <dd>
                {r.thresholdEnabled
                  ? displayTrafficUnits(r.threshold || "") +
                    " · " +
                    (r.thresholdAction === "stop" ? "关机" : "仅通知")
                  : "关闭"}
              </dd>
            </div>
            <div>
              <dt>执行决定</dt>
              <dd>
                {r.decision === "start"
                  ? "准备开机"
                  : r.decision === "stop"
                    ? "准备关机"
                    : "无需操作"}
              </dd>
            </div>
            {r.execution && r.execution !== "none" && (
              <div>
                <dt>执行阶段</dt>
                <dd>{states[r.execution] || r.execution}</dd>
              </div>
            )}
            {r.stoppedMode && (
              <div>
                <dt>停机模式</dt>
                <dd>
                  {r.stoppedMode === "KeepCharging" ? "普通停机" : "节省停机"}
                </dd>
              </div>
            )}
            {r.billing && (
              <div>
                <dt>本月费用</dt>
                <dd>
                  {r.billing.amount == null
                    ? "待同步"
                    : r.billing.amount.toFixed(2) + " " + r.billing.currency}
                  {r.billing.stale ? " · 历史数据" : ""}
                </dd>
              </div>
            )}
            {r.hold && (
              <div>
                <dt>停止保护</dt>
                <dd>{r.hold === "manual" ? "手动停机" : "流量保护"}</dd>
              </div>
            )}
            {r.scheduleEnabled && (
              <div>
                <dt>定时</dt>
                <dd>
                  {r.start}–{r.stop} · {r.timezone}
                </dd>
              </div>
            )}
          </dl>
          {(r.error || r.usage?.error || r.billing?.error) && (
            <>
              <ErrorBox
                error={logErrorText(
                  r.error || r.usage?.error || r.billing?.error,
                )}
              />
              <OriginalLogError
                value={r.error || r.usage?.error || r.billing?.error}
              />
            </>
          )}
          <details className="log-technical">
            <summary>实例信息与数据时间</summary>
            <dl className="log-metadata">
              <div>
                <dt>地域</dt>
                <dd>{r.region}</dd>
              </div>
              <div>
                <dt>实例 ID</dt>
                <dd>{r.id}</dd>
              </div>
              {groupDataTimes([
                { label: "状态更新", value: r.statusAt },
                { label: "流量更新", value: r.usage?.at },
              ]).map((g) => (
                <div key={g.text}>
                  <dt>{g.labels.join(" / ")}</dt>
                  <dd>{g.text}</dd>
                </div>
              ))}
            </dl>
          </details>
        </article>
      ))}
    </div>
  );
}
const pageSizes = [20, 50, 100];
const pageSizeKey = "aliyun-panel:logs-page-size:v1";
function savedPageSize() {
  try {
    const value = Number(localStorage.getItem(pageSizeKey));
    if (pageSizes.includes(value)) return value;
  } catch {
    // Keep pagination usable when browser storage is unavailable
  }
  return 20;
}
export default function Logs() {
  const p = usePanel(),
    d = useData<{ items: any[]; at: number }>("/audit", p.revision);
  const [view, setView] = useState("all"),
    [level, setLevel] = useState("all"),
    [instance, setInstance] = useState("all"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [pageSize, setPageSize] = useState(savedPageSize),
    [detail, setDetail] = useState<any>();
  const all = d.data?.items || [];
  const rows = all.filter(
    (r) =>
      (view === "all" ||
        (view === "checks"
          ? r.category === "monitor"
          : r.category !== "monitor")) &&
      (level === "all" ||
        (r.level || (r.status === "failed" ? "error" : "info")) === level) &&
      (instance === "all" ||
        r.target === instance ||
        r.context?.resources?.some((i: any) => i.id === instance)) &&
      (!search ||
        JSON.stringify({ ...r, label: actionLabel(r.action) })
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const pages = Math.max(1, Math.ceil(rows.length / pageSize)),
    activePage = Math.min(page, pages - 1);
  const visibleRows = rows.slice(
    activePage * pageSize,
    (activePage + 1) * pageSize,
  );
  const scopeName =
    instance === "all"
      ? "系统日志"
      : p.snapshot.items.find((i) => i.id === instance)?.name || "实例日志";
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            <ScrollText size={22} />
            日志
          </h1>
        </div>
        <div className="row">
          <RefreshButton loading={d.loading} onClick={p.refresh} />
          <button
            className="button"
            onClick={async () => {
              if (!confirm("清空全部日志？")) return;
              try {
                await api("/audit", undefined, "DELETE");
                p.refresh();
              } catch (e) {
                p.notice((e as Error).message, true);
              }
            }}
          >
            清空日志
          </button>
        </div>
      </div>
      <div className="toolbar log-stream-filters">
        <Select
          aria-label="日志来源"
          value={instance}
          onChange={(e) => {
            setInstance(e.target.value);
            setPage(0);
          }}
        >
          <option value="all">系统日志</option>
          {p.snapshot.items.map((i) => (
            <option key={i.accountId + i.region + i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="日志级别"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setPage(0);
          }}
        >
          <option value="all">全部级别</option>
          {Object.entries(levels).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
        <SearchInput
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(0);
          }}
          placeholder="搜索实例、原因或请求 ID…"
        />
      </div>
      <ErrorBox error={d.error} />
      <section className="log-feed" aria-label="运行日志">
        <div className="log-feed-head">
          <div className="log-tabs" role="group" aria-label="日志类型">
            {[
              ["all", "全部"],
              ["events", "事件"],
              ["checks", "检测"],
            ].map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  setPage(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="muted">
            {d.initialLoading ? (
              <Skeleton />
            ) : (
              <>
                {rows.length} 条 · 刷新时间 {date(d.data?.at)}
              </>
            )}
          </span>
        </div>
        <DataRegion pending={d.initialLoading} placeholder={<LoadingLogs />}>
          <ol className="log-stream">
            {visibleRows.map((r) => {
              const severity =
                r.level || (r.status === "failed" ? "error" : "info");
              const name =
                r.action === "monitor-cycle"
                  ? undefined
                  : r.context?.instanceName ||
                    (r.context?.accountName ? undefined : r.target);
              const resources = sortByName<any>(
                (r.context?.resources || []).filter(
                  (i: any) => instance === "all" || i.id === instance,
                ),
              );
              const eventSummary = eventLogSummary(r.context || {});
              const hasDetails =
                !!r.detail || (r.context && Object.keys(r.context).length > 0);
              return (
                <li className={"log-stream-row " + severity} key={r.id}>
                  <span
                    className={"log-dot " + severity}
                    aria-label={levels[severity]}
                  />
                  <div className="log-stream-copy">
                    <p>
                      {name && !r.detail?.includes(name) && (
                        <span className="log-object">{name} · </span>
                      )}
                      {r.action === "monitor-cycle" && resources.length
                        ? monitorLogTitle(resources)
                        : logErrorText(r.detail || actionLabel(r.action))}
                    </p>
                    {resources.length > 0 && (
                      <div className="log-resource-preview">
                        <table
                          className="log-resource-table"
                          aria-label="实例检测明细"
                        >
                          <colgroup>
                            <col className="log-resource-name-column" />
                            <col className="log-resource-status-column" />
                            <col className="log-resource-traffic-column" />
                            <col className="log-resource-keepalive-column" />
                            <col className="log-resource-cost-column" />
                          </colgroup>
                          <thead>
                            <tr>
                              <th scope="col">实例</th>
                              <th scope="col">状态</th>
                              <th scope="col">本月流量</th>
                              <th scope="col">保活</th>
                              <th scope="col">本月费用</th>
                            </tr>
                          </thead>
                          <tbody>
                            {resources.slice(0, 3).map((i: any) => {
                              const summary = resourceLogSummary(i);
                              return (
                                <Fragment key={i.accountId + i.region + i.id}>
                                  <tr>
                                    <th scope="row">
                                      {i.name}
                                      {summary.action && (
                                        <span className="log-resource-action">
                                          {summary.action}
                                        </span>
                                      )}
                                    </th>
                                    <td>
                                      <span
                                        className={
                                          "log-resource-status " +
                                          (i.status === "Running"
                                            ? "running"
                                            : "")
                                        }
                                      >
                                        {summary.status}
                                      </span>
                                    </td>
                                    <td className="numeric">
                                      {summary.traffic}
                                    </td>
                                    <td>{summary.keepAlive}</td>
                                    <td className="numeric">{summary.cost}</td>
                                  </tr>
                                  {summary.error && (
                                    <tr className="log-resource-error">
                                      <td colSpan={5} className="danger-text">
                                        {i.name} · {summary.error}
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                        {resources.length > 3 && (
                          <div className="log-resource-more">
                            其余 {resources.length - 3} 台见详情
                          </div>
                        )}
                      </div>
                    )}
                    {!resources.length && eventSummary && (
                      <div className="log-event-summary">{eventSummary}</div>
                    )}
                    <div className="log-line-meta">
                      <time dateTime={new Date(r.at).toISOString()}>
                        {date(r.at)}
                      </time>
                      <span>
                        {r.action === "monitor-cycle"
                          ? r.context?.source === "manual"
                            ? "手动检测"
                            : "后台检测"
                          : actionLabel(r.action)}
                      </span>
                      {severity !== "info" && (
                        <span className={"log-severity " + severity}>
                          {levels[severity]}
                        </span>
                      )}
                    </div>
                  </div>
                  {hasDetails && (
                    <button
                      className="log-open icon-button"
                      aria-label={actionLabel(r.action) + "详情"}
                      title="查看详情"
                      onClick={() => setDetail(r)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          {!rows.length && (
            <Empty>
              {view === "events"
                ? "暂无事件日志"
                : view === "checks"
                  ? "尚无检测记录"
                  : "暂无符合条件的日志"}
            </Empty>
          )}
          <div className="log-feed-footer pagination">
            <span className="log-retention muted">最多保留 5,000 条</span>
            <Select
              aria-label="每页日志条数"
              menuMinWidth={160}
              value={pageSize}
              onChange={(e) => {
                const value = Number(e.target.value);
                setPageSize(value);
                setPage(0);
                try {
                  localStorage.setItem(pageSizeKey, String(value));
                } catch {
                  // The selection still applies for the current visit
                }
              }}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size} 条 / 页
                </option>
              ))}
            </Select>
            <small className="muted">
              第 {activePage + 1} / {pages} 页
            </small>
            <button
              className="button"
              disabled={!activePage}
              onClick={() => setPage(activePage - 1)}
            >
              上一页
            </button>
            <button
              className="button"
              disabled={activePage === pages - 1}
              onClick={() => setPage(activePage + 1)}
            >
              下一页
            </button>
          </div>
        </DataRegion>
      </section>
      {detail && (
        <Modal
          title={actionLabel(detail.action)}
          description={date(detail.at) + " · " + scopeName}
          onClose={() => setDetail(undefined)}
          className="log-detail-modal"
          wide={!!detail.context?.resources?.length}
        >
          <p className="log-detail-summary">{logErrorText(detail.detail)}</p>
          <OriginalLogError value={detail.detail} />
          <LogDetails
            context={detail.context || {}}
            selectedInstance={instance}
          />
        </Modal>
      )}
    </>
  );
}
