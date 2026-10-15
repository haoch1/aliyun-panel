import { z } from "zod";
const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式须为 HH:mm");
export const region = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const target = z
  .object({
    accountId: z.string().min(1).max(128),
    region,
    id: z.string().min(1).max(128),
  })
  .strict();
export const accountInput = z
  .object({
    name: z.string().min(1).max(80),
    accessKeyId: z.string().min(1).max(128),
    accessKeySecret: z.string().max(256).default(""),
    site: z.enum(["china", "international"]).default("china"),
    region: region.default("cn-hangzhou"),
  })
  .strict();
export const ruleInput = z
  .object({
    keepAlive: z.boolean().nullable().optional(),
    paused: z.boolean(),
    thresholdEnabled: z.boolean(),
    thresholdPercent: z.number().min(0.1).max(100),
    thresholdAction: z.enum(["stop", "notify"]),
    thresholdUnit: z.enum(["percent", "gib"]).default("percent"),
    thresholdGiB: z.number().min(0.01).max(1000000).default(180),
    autoRecover: z.boolean().default(false),
    stoppedMode: z
      .enum(["KeepCharging", "StopCharging"])
      .default("KeepCharging"),
    scheduleStopEnabled: z.boolean().default(true),
    scheduleEnabled: z.boolean(),
    start: clock,
    stop: clock,
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "时区无效"),
  })
  .strict()
  .refine(
    (v) => !v.scheduleEnabled || !v.scheduleStopEnabled || v.start !== v.stop,
    "开机和停机时间不能相同",
  );
export const settingsInput = z
  .object({
    keepAliveDefault: z
      .boolean()
      .optional()
      .transform(() => true),
    billingEnabled: z.boolean(),
    dailyReport: z.boolean(),
    reportTime: clock,
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
    checkInterval: z.number().int().min(60).max(3600).default(60),
    billingInterval: z.number().int().min(300).max(86400).default(3600),
    notifications: z
      .object({
        telegramToken: z.string().max(256),
        telegramChatId: z.string().max(100),
        telegramEnabled: z.boolean().default(true),
        mode: z.enum(["events", "errors", "always", "off"]).optional(),
        events: z
          .array(
            z.enum([
              "keepalive",
              "threshold",
              "traffic",
              "traffic-recovery",
              "schedule",
              "manual",
              "operation-error",
              "status",
              "error",
              "recovery",
              "billing",
              "billing-recovery",
              "cycle",
              "daily",
            ]),
          )
          .max(14)
          .optional(),
        apiBase: z.string().url().max(2048).default("https://api.telegram.org"),
      })
      .strict(),
  })
  .strict();
export const operationInput = target.extend({
  action: z.enum(["start", "stop", "resume"]),
  override: z.boolean().default(false),
  stoppedMode: z.enum(["KeepCharging", "StopCharging"]).default("KeepCharging"),
});

export const cycle = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "账期须为 YYYY-MM");
