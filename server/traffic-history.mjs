import { randomUUID } from "node:crypto";
import { monitorSource, errorText, networkErrorCode } from "./aliyun.mjs";
import { resourceKey } from "./store.mjs";

export const MINUTE = 60000,
  HOUR = 3600000;
const floor = (at, unit) => Math.floor(at / unit) * unit;
const ceil = (at, unit) => Math.ceil(at / unit) * unit;
const metricNames = ["INTERNET_IN", "INTERNET_OUT"];
const pollInterval = 5 * MINUTE,
  settleDelay = 5 * MINUTE,
  initialWindow = 10 * MINUTE;
const pointTime = (p) => {
  const value = p.timestamp ?? p.Timestamp ?? p.time ?? p.TimeStamp ?? p[0];
  return typeof value === "number" || /^\d{10,13}$/.test(String(value))
    ? +value < 1e12
      ? +value * 1000
      : +value
    : Date.parse(value);
};
const bytes = (p) => {
  const value = p.value ?? p.Value ?? p.average ?? p.Average ?? p[1];
  return value != null && value !== "" && Number.isFinite(+value) && +value >= 0
    ? +value
    : null;
};

/** Persist ownership intervals separately from sampling resolution. */
export class TrafficHistory {
  constructor(store, gateway, available) {
    Object.assign(this, { store, gateway, available });
    this.running = new Map();
  }
  bindings(t) {
    return this.store.db
      .prepare(
        "SELECT * FROM traffic_bindings WHERE account_id=? AND region=? AND instance_id=? ORDER BY from_at,id",
      )
      .all(t.accountId, t.region, t.id);
  }
  has(t) {
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM traffic_bindings WHERE account_id=? AND region=? AND instance_id=? LIMIT 1",
      )
      .get(t.accountId, t.region, t.id);
  }
  add(t, owner, source, from, to = null, legacy = false) {
    const id = randomUUID();
    this.store.db
      .prepare("INSERT INTO traffic_bindings VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        t.accountId,
        owner,
        t.region,
        t.id,
        source,
        from,
        to,
        Date.now(),
        +legacy,
      );
    return this.store.db
      .prepare("SELECT * FROM traffic_bindings WHERE id=?")
      .get(id);
  }
  migrate(t, owner) {
    // Old points already carry an instance and source. Never backfill an unknown
    // old binding. Overlapping legacy histories get one chronological owner.
    const groups = new Map();
    const rows = this.store.db
      .prepare(
        "SELECT body FROM entities WHERE kind='metric' AND json_extract(body,'$.accountId')=? AND json_extract(body,'$.region')=? AND json_extract(body,'$.id')=? ORDER BY json_extract(body,'$.at')",
      )
      .all(t.accountId, t.region, t.id);
    for (const row of rows) {
      const p = JSON.parse(row.body);
      let metric;
      try {
        metric = JSON.parse(p.metric);
      } catch {
        continue;
      }
      if (
        metric[0] !== "public-traffic-bytes-v2" ||
        !metricNames.includes(metric[2]) ||
        !Number.isFinite(p.value) ||
        p.value < 0
      )
        continue;
      const group = groups.get(metric[1]) || new Map();
      const point = group.get(p.at) || {
        at: p.at,
        in_bytes: null,
        out_bytes: null,
      };
      point[metric[2] === "INTERNET_IN" ? "in_bytes" : "out_bytes"] = p.value;
      group.set(p.at, point);
      groups.set(metric[1], group);
    }
    const histories = [...groups]
      .map(([source, points]) => ({ source, points: [...points.values()] }))
      .sort(
        (a, b) =>
          a.points.at(-1).at - b.points.at(-1).at ||
          a.source.localeCompare(b.source),
      );
    let until = -Infinity;
    for (const h of histories) {
      const from = Math.max(h.points[0].at - HOUR, until),
        to = h.points.at(-1).at;
      if (from >= to) continue;
      const owners = this.store.db
        .prepare(
          "SELECT from_at,to_at FROM traffic_bindings WHERE owner=? AND region=? AND source=? AND instance_id<>?",
        )
        .all(owner, t.region, h.source, t.id);
      const current =
        h === histories.at(-1) &&
        h.source === monitorSource(t) &&
        !owners.length;
      const binding = this.add(
        t,
        owner,
        h.source,
        from,
        current ? null : to,
        !current,
      );
      for (const p of h.points)
        if (
          p.at - HOUR >= from &&
          !owners.some(
            (b) => p.at > b.from_at && p.at - HOUR < (b.to_at ?? Infinity),
          )
        )
          this.save(binding, p.at, 3600, p.in_bytes, p.out_bytes);
      until = to;
    }
  }
  observe(t, at = Date.now()) {
    this.store.db.exec("BEGIN");
    try {
      const binding = this.observeBinding(t, at);
      this.store.db.exec("COMMIT");
      return binding;
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }
  observeBinding(t, at = Date.now()) {
    if (!t.publicNetwork || monitorSource(t) === "eip:unknown") return;
    const owner = this.store.account(t.accountId).cloudAccountId || t.accountId;
    const other = this.store.db
      .prepare(
        "SELECT * FROM traffic_bindings WHERE owner=? AND region=? AND source=? AND to_at IS NULL AND instance_id<>? ORDER BY seen_at DESC LIMIT 1",
      )
      .get(owner, t.region, monitorSource(t), t.id);
    if (other && other.seen_at > at) return;
    if (!this.has(t)) this.migrate(t, owner);
    let active = this.bindings(t).find((b) => b.to_at == null);
    if (active?.source === monitorSource(t)) {
      if (other && t.publicNetwork === "eip")
        this.store.db
          .prepare(
            "UPDATE traffic_bindings SET to_at=max(from_at,?) WHERE id=?",
          )
          .run(floor(at, MINUTE), other.id);
      if (at >= active.seen_at)
        this.store.db
          .prepare("UPDATE traffic_bindings SET seen_at=? WHERE id=?")
          .run(at, active.id);
      return active;
    }
    if (active && at < active.seen_at) return active;
    const last = this.bindings(t).at(-1);
    if (
      !active &&
      !last?.legacy &&
      last?.source === monitorSource(t) &&
      last.to_at != null &&
      at <= last.to_at
    )
      return;
    const boundary = floor(at, MINUTE);
    this.store.db
      .prepare(
        "UPDATE traffic_bindings SET to_at=max(from_at,?) WHERE account_id=? AND region=? AND instance_id=? AND to_at IS NULL",
      )
      .run(boundary, t.accountId, t.region, t.id);
    // An EIP can have only one observed owner, even through different RAM keys.
    if (t.publicNetwork === "eip")
      this.store.db
        .prepare(
          "UPDATE traffic_bindings SET to_at=max(from_at,?) WHERE owner=? AND region=? AND source=? AND to_at IS NULL",
        )
        .run(boundary, owner, t.region, monitorSource(t));
    return this.add(t, owner, monitorSource(t), boundary);
  }
  close(t) {
    this.store.db
      .prepare(
        "UPDATE traffic_bindings SET to_at=max(from_at,?) WHERE account_id=? AND region=? AND instance_id=? AND to_at IS NULL",
      )
      .run(floor(Date.now(), MINUTE), t.accountId, t.region, t.id);
  }
  save(binding, at, period, inbound, outbound) {
    return this.store.db
      .prepare(
        `INSERT INTO traffic_samples VALUES(?,?,?,?,?)
      ON CONFLICT(binding_id,at,period) DO UPDATE SET
        in_bytes=coalesce(excluded.in_bytes,traffic_samples.in_bytes),out_bytes=coalesce(excluded.out_bytes,traffic_samples.out_bytes)
      WHERE (excluded.in_bytes IS NOT NULL AND excluded.in_bytes IS NOT traffic_samples.in_bytes)
         OR (excluded.out_bytes IS NOT NULL AND excluded.out_bytes IS NOT traffic_samples.out_bytes)`,
      )
      .run(binding.id, at, period, inbound, outbound).changes;
  }
  missingFrom(binding, start, end, period) {
    const rows = this.store.db
      .prepare(
        "SELECT at,period FROM traffic_samples WHERE binding_id=? AND at>? AND at<=? AND in_bytes IS NOT NULL AND out_bytes IS NOT NULL",
      )
      .all(binding.id, start, ceil(end, HOUR));
    const points = new Set(
      rows.filter((r) => r.period === period).map((r) => r.at),
    );
    const hours = new Set(
      rows.filter((r) => r.period === 3600).map((r) => r.at),
    );
    for (let at = start + period * 1000; at <= end; at += period * 1000)
      if (!points.has(at) && !(period === 60 && hours.has(ceil(at, HOUR))))
        return at - period * 1000;
    return end;
  }
  async range(t, binding, start, end, period, part, cadence = pollInterval) {
    if (end <= start) return {};
    const key = JSON.stringify([binding.id, part]);
    const previous = this.store.get("traffic-binding-sync", key);
    const now = Date.now();
    const failure = this.store.get("traffic-binding-error", binding.id);
    if (failure?.retryAt > now) return failure;
    if (previous?.retryAt > now) return previous;
    if (
      !previous?.error &&
      previous?.start <= start &&
      previous.end >= end &&
      previous.complete &&
      previous.checkedAt >= end + settleDelay &&
      (period === 3600 || part === "head" || binding.to_at != null)
    )
      return previous;
    // A moving range end must not bypass the cadence on every SSE/page read.
    // A newly closed binding or completed head gets one immediate final read.
    const coveredStart = previous?.start <= start && previous.end >= start,
      closing = binding.to_at != null && previous?.closedAt !== binding.to_at,
      headFinished =
        part === "head" && previous?.end < end && end <= floor(now, HOUR);
    if (coveredStart && !closing && !headFinished) {
      if (now - previous.checkedAt < cadence) return previous;
      if (previous.end >= end && previous.nextAt > now) return previous;
    }
    const contiguous = previous?.start === start && previous.end >= start;
    const from =
      period === 3600
        ? Math.max(
            start,
            Math.min(this.missingFrom(binding, start, end, period), end - HOUR),
          )
        : contiguous
          ? Math.max(
              start,
              Math.min(previous.missingFrom ?? previous.end, end) - 2 * MINUTE,
            )
          : start;
    try {
      const source = binding.source;
      const target = {
        ...t,
        publicNetwork: source.startsWith("eip:") ? "eip" : "ecs",
        eipAllocationId: source.startsWith("eip:")
          ? source.slice(4)
          : undefined,
      };
      const series = await Promise.all(
        metricNames.map((m) =>
          this.gateway.monitor(target, m, from, end, period),
        ),
      );
      if (!this.available(t)) return {};
      const latest = this.store.db
        .prepare("SELECT * FROM traffic_bindings WHERE id=?")
        .get(binding.id);
      if (!latest) return {};
      const points = new Map();
      for (let i = 0; i < series.length; i++)
        for (const p of series[i]) {
          const at = pointTime(p);
          if (
            !Number.isFinite(at) ||
            at <= from ||
            at > end ||
            at - period * 1000 < latest.from_at ||
            at > (latest.to_at ?? Infinity)
          )
            continue;
          const row = points.get(at) || [null, null];
          row[i] = bytes(p);
          points.set(at, row);
        }
      let changed = 0;
      const completeHours =
        period === 60
          ? new Set(
              this.store.db
                .prepare(
                  "SELECT at FROM traffic_samples WHERE binding_id=? AND period=3600 AND at>? AND at<=? AND in_bytes IS NOT NULL AND out_bytes IS NOT NULL",
                )
                .all(binding.id, floor(from, HOUR), ceil(end, HOUR))
                .map((r) => r.at),
            )
          : new Set();
      this.store.db.exec("BEGIN");
      try {
        for (const [at, values] of points) {
          if (period === 60 && completeHours.has(ceil(at, HOUR))) continue;
          changed += this.save(latest, at, period, ...values);
          // Compact minute tails only once a complete hour covers the same owner.
          if (period === 3600 && values.every((v) => v != null))
            this.store.db
              .prepare(
                "DELETE FROM traffic_samples WHERE binding_id=? AND period=60 AND at>? AND at<=?",
              )
              .run(latest.id, at - HOUR, at);
        }
        this.store.db.exec("COMMIT");
      } catch (e) {
        this.store.db.exec("ROLLBACK");
        throw e;
      }
      const missingFrom = this.missingFrom(latest, start, end, period);
      const stalled =
        missingFrom < end && previous?.missingFrom === missingFrom
          ? (previous.stalled || 0) + 1
          : 0;
      const delay =
        latest.to_at != null && now - latest.to_at >= initialWindow
          ? Math.min(HOUR, pollInterval * 2 ** Math.min(stalled, 4))
          : cadence;
      const state = {
        ...t,
        bindingId: binding.id,
        start,
        end,
        checkedAt: now,
        missingFrom,
        complete: missingFrom === end,
        closedAt: latest.to_at,
        stalled,
        nextAt: now + delay,
      };
      this.store.put("traffic-binding-sync", key, state);
      if (failure) this.store.remove("traffic-binding-error", binding.id);
      if (changed)
        this.store.put("health", "traffic:" + resourceKey(t), { at: now });
      return state;
    } catch (e) {
      if (!this.available(t)) return {};
      const errorCode = networkErrorCode(e),
        error = errorText(e);
      const failures = (failure?.failures || 0) + 1,
        retryDelay =
          (errorCode ? MINUTE : pollInterval) *
          (binding.to_at == null ? 1 : 2 ** Math.min(failures - 1, 6));
      const state = {
        ...previous,
        ...t,
        bindingId: binding.id,
        error,
        errorCode,
        retryAt: now + Math.min(HOUR, retryDelay),
        failures,
      };
      this.store.put("traffic-binding-sync", key, state);
      this.store.put("traffic-binding-error", binding.id, state);
      this.store.audit({
        account: t.accountId,
        action: "traffic-query",
        category: "query",
        target: this.available(t).name,
        status: "failed",
        detail: error,
        context: {
          api: binding.source.startsWith("eip:")
            ? "DescribeEipMonitorData"
            : "DescribeInstanceMonitorData",
          region: t.region,
          instanceId: t.id,
          start: from,
          end,
          retryAt: state.retryAt,
          errorCode: errorCode || e.code,
        },
      });
      return state;
    }
  }
  async sync(t, start, end) {
    t = { accountId: t.accountId, region: t.region, id: t.id };
    const key = resourceKey(t);
    if (this.running.has(key)) {
      await this.running.get(key);
      return this.sync(t, start, end);
    }
    const run = async () => {
      const instance = this.available(t);
      if (!instance) return [];
      this.observe(instance, instance.statusAt || Date.now());
      const results = [];
      for (const b of this.bindings(t)) {
        if (b.legacy || b.from_at > end || (b.to_at ?? Infinity) <= start)
          continue;
        const fresh =
          Date.now() - b.from_at < initialWindow &&
          !this.store.db
            .prepare(
              "SELECT 1 FROM traffic_samples WHERE binding_id=? AND in_bytes IS NOT NULL AND out_bytes IS NOT NULL LIMIT 1",
            )
            .get(b.id);
        const cadence = fresh ? MINUTE : pollInterval;
        if (
          b.from_at === end &&
          b.to_at == null &&
          b.source.startsWith("eip:")
        ) {
          results.push(
            await this.range(t, b, end - MINUTE, end, 60, "head", cadence),
          );
          continue;
        }
        const from = Math.max(start, b.from_at),
          to = Math.min(end, b.to_at ?? Infinity);
        const hourFrom = ceil(from, HOUR),
          hourTo = floor(Math.min(to, Date.now() - settleDelay), HOUR);
        if (hourTo > hourFrom)
          results.push(await this.range(t, b, hourFrom, hourTo, 3600, "hours"));
        if (!b.source.startsWith("eip:")) continue;
        const headEnd = Math.min(to, hourFrom);
        if (headEnd > from)
          results.push(
            await this.range(t, b, from, headEnd, 60, "head", cadence),
          );
        // Re-read the recent minute tail as well: delayed hourly data must not
        // hide a completed hour, and aggregation never adds both resolutions.
        const tailFrom = Math.max(from, hourTo - HOUR, headEnd);
        if (to > tailFrom)
          results.push(
            await this.range(t, b, tailFrom, to, 60, "tail", cadence),
          );
      }
      return results;
    };
    const pending = run().finally(() => this.running.delete(key));
    this.running.set(key, pending);
    return pending;
  }
  days(t, start, end) {
    const days = new Map();
    for (const b of this.bindings(t)) {
      const from = Math.max(start, b.from_at),
        to = Math.min(end, b.to_at ?? Infinity);
      if (to <= from) continue;
      const points = this.store.db
        .prepare(
          "SELECT * FROM traffic_samples WHERE binding_id=? AND at>? AND at<=? ORDER BY period DESC,at",
        )
        .all(b.id, from, to);
      const hours = new Map();
      for (const p of points) {
        if (p.at - p.period * 1000 < from) continue;
        const hour = floor(p.at - 1, HOUR),
          group = hours.get(hour) || { hourly: null, minutes: [] };
        if (p.period === 3600) group.hourly = p;
        else group.minutes.push(p);
        hours.set(hour, group);
      }
      for (const group of hours.values()) {
        for (const [field, column] of [
          ["inBytes", "in_bytes"],
          ["outBytes", "out_bytes"],
        ]) {
          const rows =
            group.hourly?.[column] != null ? [group.hourly] : group.minutes;
          for (const p of rows) {
            if (p[column] == null) continue;
            const date = new Date(p.at - 1 + 8 * HOUR)
              .toISOString()
              .slice(0, 10);
            const day = days.get(date) || {
              date,
              inBytes: null,
              outBytes: null,
              inPoints: 0,
              outPoints: 0,
            };
            day[field] = (day[field] ?? 0) + p[column];
            day[field === "inBytes" ? "inPoints" : "outPoints"]++;
            days.set(date, day);
          }
        }
      }
    }
    return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
  }
}
