const audiences = {
  accounts: ["accounts", "instances", "traffic", "billing"],
  scope: ["accounts", "instances", "traffic"],
  resources: ["instances", "traffic"],
  job: ["instances"],
  rule: ["instances"],
  billing: ["instances", "billing"],
  settings: ["instances", "settings", "billing"],
  audit: ["audit"],
  "log-detail": ["audit"],
  outbox: ["settings"],
  "traffic-sync": ["instances", "traffic"],
  "traffic-read-error": ["instances", "traffic"],
  "traffic-binding-sync": ["instances", "traffic"],
  "traffic-binding-error": ["instances", "traffic"],
  "traffic-binding-unavailable": ["instances", "traffic"],
} as const;

export type RefreshGroup = (typeof audiences)[keyof typeof audiences][number];
export function eventGroups(event: string): readonly RefreshGroup[] {
  try {
    const { type } = JSON.parse(event);
    return Object.hasOwn(audiences, type)
      ? audiences[type as keyof typeof audiences]
      : [];
  } catch {
    return [];
  }
}
