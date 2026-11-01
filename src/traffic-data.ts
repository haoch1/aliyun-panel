import type { Instance, TrafficSnapshot } from "../shared/types";
import { target, useData } from "./lib";

export type TrafficData = TrafficSnapshot;

// The list and detail view read the same range and subscribe to the same result.
// A changed public-network binding or calendar month must not reuse old totals.
export function useTraffic(
  instance: Instance | undefined,
  days: string,
  revision = 0,
) {
  const t = instance ? target(instance) : undefined;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const source =
    instance?.publicNetwork === "eip"
      ? "eip:" + instance.eipAllocationId
      : instance?.publicNetwork || "pending";
  return useData<TrafficData>(
    t ? "/traffic?" + new URLSearchParams({ ...t, days }) : null,
    JSON.stringify([revision, instance?.trafficAt]),
    true,
    JSON.stringify([source, days === "month" ? today.slice(0, 7) : today]),
    days === "month" ? instance?.traffic : undefined,
  );
}
