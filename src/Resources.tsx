import { ArrowDownUp } from "lucide-react";
import { useState } from "react";
import type { Instance } from "../shared/types";
import { trafficRange, trafficTotals } from "../shared/traffic-presentation";
import DailyTrafficChart from "./components/DailyTrafficChart";
import { RefreshButton } from "./components/ui/RefreshButton";
import { DataRegion, Skeleton, LoadingTable } from "./components/ui/DataRegion";
import {
  bytes,
  date,
  Empty,
  ErrorBox,
  InstanceSelect,
  key,
  target,
  useInstance,
  usePanel,
} from "./lib";
import { useTraffic } from "./traffic-data";
function TrafficAmount({ value }: { value: number | null }) {
  const [amount, unit] = bytes(value).split(" ");
  return (
    <strong>
      <span>{amount}</span>
      {unit && <span className="traffic-unit">{unit}</span>}
    </strong>
  );
}
export function Traffic({ instance: supplied }: { instance?: Instance }) {
  const p = usePanel(),
    selection = useInstance();
  const instance = supplied
    ? p.snapshot.items.find((i) => key(i) === key(supplied)) || supplied
    : selection.instance;
  const [days, setDays] = useState("month"),
    [revision, setRevision] = useState(0);
  const t = instance ? target(instance) : undefined;
  const d = useTraffic(instance, days, revision);
  const rows = [...(d.data?.items || [])].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
    totals = trafficTotals(rows);
  return (
    <div className={"traffic-content" + (supplied ? " embedded-view" : "")}>
      {!supplied && (
        <div className="page-heading">
          <div>
            <h1>
              <ArrowDownUp size={22} />
              流量统计
            </h1>
          </div>
        </div>
      )}
      {!supplied && (
        <div className="traffic-instance-picker">
          <span>实例</span>
          <InstanceSelect
            value={selection.value}
            onChange={selection.setValue}
          />
        </div>
      )}
      <div className="toolbar traffic-toolbar">
        <div className="traffic-periods" role="group" aria-label="统计范围">
          {[
            ["month", "本月"],
            ["7", "近 7 天"],
            ["30", "近 30 天"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={"button" + (days === value ? " primary" : "")}
              aria-pressed={days === value}
              disabled={!t}
              onClick={() => setDays(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <RefreshButton
          loading={d.loading}
          disabled={!t}
          onClick={() => setRevision((v) => v + 1)}
        />
      </div>
      <ErrorBox error={d.error || d.data?.errors.join("；")} />
      {instance && (
        <>
          <section
            className="traffic-overview"
            aria-label="流量汇总"
            aria-busy={d.loading}
          >
            <div>
              <span>入站流量</span>
              <DataRegion
                pending={d.initialLoading}
                placeholder={<Skeleton className="skeleton-stat" />}
              >
                <TrafficAmount value={totals.inbound} />
              </DataRegion>
            </div>
            <div>
              <span>出站流量</span>
              <DataRegion
                pending={d.initialLoading}
                placeholder={<Skeleton className="skeleton-stat" />}
              >
                <TrafficAmount value={totals.outbound} />
              </DataRegion>
            </div>
            <div>
              <span>合计流量</span>
              <DataRegion
                pending={d.initialLoading}
                placeholder={<Skeleton className="skeleton-stat" />}
              >
                <TrafficAmount value={totals.total} />
              </DataRegion>
            </div>
          </section>
          <div
            className="traffic-range"
            title={"刷新时间 " + date(d.data?.checkedAt)}
          >
            <DataRegion pending={d.initialLoading} placeholder={<Skeleton />}>
              {trafficRange(d.data?.start, d.data?.end)}
            </DataRegion>
          </div>
        </>
      )}
      {!t ? (
        <Empty>暂无实例，请先添加实例</Empty>
      ) : (
        <>
          <DailyTrafficChart
            key={key(instance!) + days}
            rows={rows}
            loading={d.initialLoading}
          />
          <details className="traffic-details" open>
            <summary>每日明细</summary>
            <DataRegion
              pending={d.initialLoading}
              placeholder={
                <LoadingTable columns={["日期", "入站", "出站", "合计"]} />
              }
            >
              <div className="table-wrap">
                <table className="compact-table traffic-daily-table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>入站</th>
                      <th>出站</th>
                      <th>合计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.date}>
                        <td data-label="日期">{r.date}</td>
                        <td data-label="入站">{bytes(r.inBytes)}</td>
                        <td data-label="出站">{bytes(r.outBytes)}</td>
                        <td data-label="合计">
                          {bytes(
                            r.inBytes != null && r.outBytes != null
                              ? r.inBytes + r.outBytes
                              : null,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DataRegion>
          </details>
        </>
      )}
    </div>
  );
}
