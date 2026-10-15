export interface Account {
  id: string;
  name: string;
  cloudAccountId: string;
  principalId: string;
  site: "china" | "international";
  region: string;
  keyTail: string;
  accessStatus?: "readable" | "error" | "pending";
  accessError?: string;
  accessKeyId?: string;
  monitors?: { region: string; id: string; name?: string }[];
}
export type ToastFn = (
  message: string,
  type?: "success" | "error" | "info",
) => void;
export interface Rule {
  accountId: string;
  region: string;
  id: string;
  keepAlive: boolean | null;
  paused: boolean;
  thresholdEnabled: boolean;
  thresholdPercent: number;
  thresholdAction: "stop" | "notify";
  thresholdUnit?: "percent" | "gib";
  thresholdGiB?: number;
  autoRecover?: boolean;
  stoppedMode?: "KeepCharging" | "StopCharging";
  scheduleStopEnabled?: boolean;
  scheduleEnabled: boolean;
  start: string;
  stop: string;
  timezone: string;
  revision?: string;
  hold?: string;
  lastCheck?: string;
  lastAction?: string;
  lastSchedule?: string;
  reason?: string;
}
export interface Usage {
  used: number | null;
  total: number | null;
  remaining: number | null;
  overflow: number | null;
  quota: "finite" | "none" | "unknown";
  at: number;
  scope?: "account";
  pool?: "china" | "international";
  error?: string;
}
export interface Instance {
  accountId: string;
  accountName: string;
  region: string;
  id: string;
  name: string;
  status: string;
  statusAt?: number;
  statusError?: string;
  ip: string[];
  privateIp: string[];
  planId: string;
  product?: "ecs";
  chargeType?: string;
  internetChargeType?: string;
  publicNetwork?: "eip" | "ecs";
  eipAllocationId?: string;
  spotStrategy?: string;
  stoppedMode?: string;
  locked?: boolean;
  cpu?: number;
  memory?: number;
  disk?: number;
  expires?: string;
  created?: string;
  usage?: Usage;
  rule: Rule;
  effectiveKeepAlive: boolean;
  job?: Job;
  error?: string;
  billing?: {
    amount: number | null;
    currency: string;
    at?: number;
    error?: string;
    stale?: boolean;
  };
  schedule?: { allowed: boolean; nextAction: string; nextAt: string };
}
export interface Job {
  id: string;
  accountId: string;
  region: string;
  instanceId: string;
  action: string;
  source: string;
  status: "queued" | "submitted" | "success" | "failed" | "attention";
  at: number;
  updatedAt: number;
  detail?: string;
  result?: Record<string, unknown>;
}
export interface Snapshot {
  items: Instance[];
  at: number;
  errors: string[];
  refreshing: boolean;
}
export interface Settings {
  keepAliveDefault: boolean;
  billingEnabled: boolean;
  dailyReport: boolean;
  reportTime: string;
  timezone: string;
  checkInterval: number;
  billingInterval: number;
  notifications: {
    telegramToken: string;
    telegramChatId: string;
    telegramEnabled: boolean;
    events?: import("./notification-preferences").NotificationType[];
    mode?: "events" | "errors" | "always" | "off";
    apiBase: string;
    telegramConfigured?: boolean;
  };
}
