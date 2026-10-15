import type { ReactNode } from "react";
import { TableLoading } from "./TableLoading";
import { Cloud } from "lucide-react";

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={"skeleton " + className} aria-hidden="true" />;
}

/** Keep the loading and content layers in one place; cached refreshes never hide content. */
export function DataRegion({
  pending,
  placeholder,
  children,
  className = "",
  inline = false,
}: {
  pending: boolean;
  placeholder: ReactNode;
  children: ReactNode;
  className?: string;
  inline?: boolean;
}) {
  const Layer = inline ? "span" : "div";
  return (
    <Layer
      className={
        "data-region " + (inline ? "data-region-inline " : "") + className
      }
      aria-busy={pending}
    >
      <Layer className="data-region-placeholder" aria-hidden="true">
        {placeholder}
      </Layer>
      {pending && (
        <span className="sr-only" role="status">
          正在读取数据…
        </span>
      )}
      <Layer
        className="data-region-content"
        aria-hidden={pending || undefined}
        inert={pending || undefined}
      >
        {children}
      </Layer>
    </Layer>
  );
}

export function LoadingTable({
  columns,
  rows = 3,
  className = "",
}: {
  columns: string[];
  rows?: number;
  className?: string;
}) {
  return (
    <div className={"table-wrap loading-table " + className}>
      <table>
        <thead>
          <tr>
            {columns.map((v, i) => (
              <th key={i}>
                {v || (
                  <span className="selection-box">
                    <Skeleton className="skeleton-count" />
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <TableLoading key={i} columns={columns} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LoadingLogs() {
  return (
    <div className="loading-logs">
      {Array.from({ length: 3 }, (_, i) => (
        <div className="loading-log" key={i}>
          <Skeleton className="skeleton-title" />
          <div className="loading-log-columns">
            {Array.from({ length: 5 }, (_, n) => (
              <Skeleton key={n} />
            ))}
          </div>
          <Skeleton className="skeleton-meta" />
        </div>
      ))}
    </div>
  );
}

export function LoadingForm() {
  return (
    <div className="loading-form form-grid">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i}>
          <Skeleton className="skeleton-label" />
          <Skeleton className="skeleton-input" />
        </div>
      ))}
    </div>
  );
}

export function PageLoading({ page }: { page: string }) {
  if (page === "instances")
    return (
      <div className="page-loading instances-loading">
        <div className="page-heading instances-heading">
          <h1>
            <Cloud size={22} />
            Aliyun 实例
          </h1>
          <div className="row loading-actions">
            <Skeleton />
            <Skeleton />
          </div>
        </div>
        <div className="instances-overview">
          <div className="instance-counts">
            {["实例", "运行中", "保活开启"].map((label) => (
              <span key={label}>
                {label}
                <Skeleton className="skeleton-count" />
              </span>
            ))}
          </div>
          <div className="instance-times">
            <Skeleton className="skeleton-meta" />
          </div>
        </div>
        <div className="toolbar instances-toolbar">
          <Skeleton className="skeleton-search" />
          <span className="instances-reset">
            <Skeleton className="skeleton-reset" />
          </span>
        </div>
        <LoadingTable
          className="instances-table"
          rows={1}
          columns={[
            "",
            "实例",
            "状态",
            "公网 IP",
            "本月流量",
            "保活",
            "保护与定时",
            "本月费用",
            "操作",
          ]}
        />
      </div>
    );
  return (
    <div className="page-loading">
      <Skeleton className="skeleton-page-title" />
      <div className="loading-toolbar">
        <Skeleton />
        <Skeleton />
      </div>
      {page === "traffic" ? (
        <>
          <div className="traffic-overview">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton className="skeleton-label" />
                <Skeleton className="skeleton-stat" />
              </div>
            ))}
          </div>
          <div className="traffic-range">
            <Skeleton />
          </div>
          <div className="daily-chart">
            <Skeleton className="skeleton-title" />
            <div className="chart-placeholder">
              {Array.from({ length: 15 }, (_, i) => (
                <Skeleton key={i} />
              ))}
            </div>
          </div>
        </>
      ) : page === "audit" ? (
        <LoadingLogs />
      ) : page === "settings" ? (
        <div className="form-panel">
          <Skeleton className="skeleton-title" />
          <LoadingForm />
        </div>
      ) : (
        <LoadingTable
          columns={
            page === "billing"
              ? ["实例", "地域", "可用余额", "税前金额", "查询状态"]
              : ["实例", "状态", "公网 IP", "本月流量", "保活", "本月费用"]
          }
        />
      )}
    </div>
  );
}
