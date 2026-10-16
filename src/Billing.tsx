import { groupDataTimes } from "../shared/presentation";
import { sortByName } from "../shared/resource-order";
import { regionName } from "../shared/regions";
import { ReceiptText } from "lucide-react";
import { useState } from "react";
import type { Instance } from "../shared/types";
import Select from "./components/ui/Select";
import { RefreshButton } from "./components/ui/RefreshButton";
import { api, date, Empty, ErrorBox, useData, usePanel } from "./lib";
import { DataRegion, LoadingTable, Skeleton } from "./components/ui/DataRegion";
export function money(value: number | null | undefined, currency: string) {
  if (value == null || !Number.isFinite(value)) return "待同步";
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currency || "CNY",
      currencyDisplay: "code",
    }).format(value);
  } catch {
    return value.toFixed(2) + " " + currency;
  }
}
const number = (v: unknown) =>
  v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
export default function Billing({
  accountId = "all",
  region = "all",
  instance,
}: {
  accountId?: string;
  region?: string;
  instance?: Instance;
}) {
  const p = usePanel();
  const current = new Date()
    .toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
    .slice(0, 7);
  const [cycle, setCycle] = useState(current),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const scope = instance?.accountId || accountId;
  const d = useData<{ items: any[] }>(
    "/billing?" + new URLSearchParams({ cycle, accountId: scope }),
    p.revision,
    true,
  );
  const bills: any[] = d.data?.items || [];
  const rows = sortByName(
    bills.flatMap((b) =>
      (b.instances || [])
        .filter((i: any) =>
          instance
            ? i.id === instance.id && i.region === instance.region
            : region === "all" || i.region === region,
        )
        .map((i: any) => ({
          ...i,
          accountId: b.accountId,
          currency: b.currency,
          balance: number(b.balance?.availableAmount),
          balanceCurrency: b.balance?.currency || b.currency,
          balanceError: b.balanceError,
          balanceAt: b.balanceAt,
          billError: b.billError,
          error: b.error,
          at: b.at,
          checkedAt: b.checkedAt,
          stale: b.stale,
        })),
    ),
  );
  const times = rows
    .flatMap((i) => [i.balanceAt, i.at])
    .filter((v): v is number => typeof v === "number" && v > 0);
  const refreshedAt = times.length ? Math.min(...times) : undefined;
  const freshnessDetail = rows
    .map(
      (i) =>
        i.name +
        "：" +
        groupDataTimes([
          { label: "余额", value: i.balanceAt },
          { label: "账单", value: i.at },
        ])
          .map((g) => g.labels.join(" / ") + " " + g.text)
          .join("；"),
    )
    .join("\n");
  const pages = Math.max(1, Math.ceil(rows.length / 6)),
    activePage = Math.min(page, pages - 1);
  const months = Array.from({ length: 12 }, (_, n) => {
    const [y, m] = current.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
  });
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api("/billing/refresh", { cycle, accountId: scope });
      p.refresh();
      p.notice(
        result.items?.some((b: any) => b.error)
          ? "部分查询失败，已保留上次成功数据"
          : "账单与余额已刷新",
        result.items?.some((b: any) => b.error),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={"billing-view " + (instance ? "embedded-view" : "")}>
      {!instance && (
        <div className="page-heading">
          <div>
            <h1>
              <ReceiptText size={22} />
              账单与余额
            </h1>
          </div>
        </div>
      )}
      <div className="toolbar billing-toolbar">
        <span className="muted">账期</span>
        <Select
          aria-label="账期"
          value={cycle}
          onChange={(e) => {
            setCycle(e.target.value);
            setPage(0);
          }}
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <span className="muted billing-refresh-time" title={freshnessDetail}>
          {d.initialLoading ? (
            <Skeleton />
          ) : (
            <>
              刷新时间 {date(refreshedAt)}
              {rows.length > 0 && times.length < rows.length * 2
                ? " · 部分数据待同步"
                : ""}
            </>
          )}
        </span>
        <RefreshButton loading={busy || d.loading} onClick={refresh} />
      </div>

      {p.settings && !p.settings.billingEnabled && (
        <div className="info-box">自动查询已关闭，仍可手动刷新</div>
      )}
      <ErrorBox error={error || d.error} />
      <DataRegion
        pending={d.initialLoading}
        placeholder={
          <LoadingTable
            columns={["实例", "地域", "可用余额", "税前金额", "查询状态"]}
            rows={Math.min(6, Math.max(1, p.snapshot.items.length))}
          />
        }
      >
        {rows.length > 0 ? (
          <section className="billing-section">
            <div className="section-heading">
              <h2>
                实例明细 <span className="muted">({rows.length})</span>
              </h2>
            </div>
            <div className="table-wrap">
              <table className="compact-table">
                <thead>
                  <tr>
                    <th>实例</th>
                    <th>地域</th>
                    <th title="同一凭据归属的实例共用余额，不能逐行相加">
                      可用余额
                    </th>
                    <th>税前金额</th>
                    <th>查询状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(activePage * 6, activePage * 6 + 6).map((i) => (
                    <tr key={i.accountId + i.region + i.id}>
                      <td title={i.id}>{i.name}</td>
                      <td>{regionName(i.region)}</td>
                      <td className="amount-cell">
                        {money(i.balance, i.balanceCurrency)}
                        {i.balanceError && i.balance != null && (
                          <div className="subline danger-text">
                            上次成功数据
                          </div>
                        )}
                      </td>
                      <td className="amount-cell">
                        {money(i.amount, i.currency)}
                        {i.billError && i.amount != null && (
                          <div className="subline danger-text">
                            上次成功数据
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={"badge " + (i.error ? "warn" : "")}>
                          {i.error
                            ? "部分失败"
                            : !i.at && !i.balanceAt
                              ? "待同步"
                              : i.stale
                                ? "待刷新"
                                : "已同步"}
                        </span>
                        {i.error && (
                          <details className="billing-error">
                            <summary>查看原因</summary>
                            <div>{i.error}</div>
                            <small>
                              保留上次成功数据；最近尝试 {date(i.checkedAt)}
                            </small>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="pagination">
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
            )}
          </section>
        ) : (
          <Empty>
            {p.snapshot.items.length
              ? d.error
                ? "暂时无法读取账单，请刷新重试"
                : "该账期暂无账单数据"
              : "添加实例后查看账单与余额"}
          </Empty>
        )}
      </DataRegion>
    </div>
  );
}
