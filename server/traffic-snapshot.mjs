import { errorText, monitorSource, trafficMetric } from "./aliyun.mjs";
import { resourceKey } from "./store.mjs";
import { HOUR, MINUTE } from "./traffic-history.mjs";

// Database-only reads must never discover instances, refresh CDT or poll monitors.
export function trafficSnapshot(store, history, instance, days) {
  const tracked = instance.publicNetwork === "eip" || history.has(instance);
  const now = Date.now(),
    end =
      Math.floor(now / (tracked ? MINUTE : HOUR)) * (tracked ? MINUTE : HOUR),
    local = new Date(now + 8 * HOUR).toISOString(),
    start =
      days === "month"
        ? Date.parse(local.slice(0, 7) + "-01T00:00:00+08:00")
        : Date.parse(local.slice(0, 10) + "T00:00:00+08:00") -
          (days - 1) * 86400000;
  const states = [],
    rows = new Map();
  const failed = store.get("traffic-read-error", resourceKey(instance));
  if (failed?.source === monitorSource(instance)) states.push(failed);
  let items = [];
  if (tracked) {
    items = history.days(instance, start, end);
    for (const b of history.bindings(instance)) {
      if (
        b.legacy ||
        b.from_at > end ||
        (b.to_at ?? Infinity) <= start ||
        store.get("traffic-binding-unavailable", b.id)
      )
        continue;
      for (const part of ["head", "hours", "tail"]) {
        const state = store.get(
          "traffic-binding-sync",
          JSON.stringify([b.id, part]),
        );
        if (state) states.push({ ...state, error: undefined });
      }
      const failure = store.get("traffic-binding-error", b.id);
      if (failure) states.push({ ...failure, historical: b.to_at != null });
    }
  } else if (instance.publicNetwork && end > start) {
    const source = monitorSource(instance),
      saved = store.get("traffic-sync", resourceKey(instance));
    if (saved?.source === source) states.push(saved);
    for (const metric of ["INTERNET_IN", "INTERNET_OUT"])
      for (const p of store.metrics(
        instance,
        trafficMetric(source, metric),
        start,
        end,
      )) {
        const date = new Date(p.at - 1 + 8 * HOUR).toISOString().slice(0, 10),
          r = rows.get(date) || {
            date,
            inBytes: null,
            outBytes: null,
            inPoints: 0,
            outPoints: 0,
          },
          field = metric === "INTERNET_IN" ? "inBytes" : "outBytes";
        r[field] = (r[field] ?? 0) + p.value;
        r[field === "inBytes" ? "inPoints" : "outPoints"]++;
        rows.set(date, r);
      }
    items = [...rows.values()].sort((a, b) => b.date.localeCompare(a.date));
  }
  return {
    start,
    end,
    timezone: "Asia/Shanghai",
    estimated: true,
    checkedAt: Math.max(0, ...states.map((s) => s.checkedAt || 0)),
    usage: instance.usage,
    items,
    errors: [
      ...new Set(
        states
          .filter((s) => s.error && !s.historical)
          .map(
            (s) =>
              errorText({ message: s.error, code: s.errorCode }) +
              (items.length ? "；已保留上次流量数据" : ""),
          ),
      ),
    ],
    warnings: [
      ...new Set(
        states
          .filter((s) => s.error && s.historical)
          .map(
            (s) =>
              "旧 EIP 历史补采暂时失败，已保留累计；当前 EIP 单独采集：" +
              errorText({ message: s.error, code: s.errorCode }),
          ),
      ),
    ],
  };
}
