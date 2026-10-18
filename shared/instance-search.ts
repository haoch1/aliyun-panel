import { regionName } from "./regions.ts";
import type { Instance } from "./types.ts";

export function matchesInstanceSearch(
  instance: Pick<Instance, "name" | "id" | "region" | "ip">,
  query: string,
) {
  const search = query.trim().toLowerCase();
  return [
    instance.name,
    instance.id,
    instance.region,
    regionName(instance.region),
    ...instance.ip,
  ].some((value) => value.toLowerCase().includes(search));
}
