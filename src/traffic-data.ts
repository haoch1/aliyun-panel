import type { Instance } from "../shared/types";
import type { TrafficDay } from "../shared/traffic-presentation";
import { target, useData } from "./lib";

export interface TrafficData {
  items: TrafficDay[];
  errors: string[];
  start: number;
  end: number;
  timezone: string;
  checkedAt?: number;
}

// The list and detail view read the same range and subscribe to the same result.
// A changed public-network binding or calendar month must not reuse old totals.
export function useTraffic(
  instance: Instance | undefined,
  days: string,
  revision = 0,
) {
  const t = instance ? target(instance) : undefined;
  const month = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
  const source =
    instance?.publicNetwork === "eip"
      ? "eip:" + instance.eipAllocationId
      : instance?.publicNetwork || "pending";
  return useData<TrafficData>(
    t ? "/traffic?" + new URLSearchParams({ ...t, days }) : null,
    revision,
    true,
    JSON.stringify([source, month, instance?.trafficAt]),
  );
}
