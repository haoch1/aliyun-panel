import type { Instance, Rule, Settings } from "./types";
export function zoned(
  now: Date | number,
  timezone: string,
): { date: string; clock: string; month: string };
export function inWindow(clock: string, start: string, stop: string): boolean;
export function clockDue(
  now: Date | number,
  timezone: string,
  clock: string,
): boolean;
export function thresholdTransition(
  previous: any,
  rule: Rule,
  usage: Instance["usage"],
  now?: number,
): {
  state: any;
  event?: string;
};
export function schedule(
  rule: Rule,
  now: Date | number,
): {
  date: string;
  clock: string;
  month: string;
  allowed: boolean;
  startDue: boolean;
  key: string;
  token: string;
  startPending: boolean;
};
export function usageOver(
  rule: Rule,
  usage: Instance["usage"],
  now?: number,
): { valid: boolean; over: boolean };
export function decide(
  instance: Instance,
  rule: Rule,
  settings: Settings,
  options?: { now?: number; busy?: boolean; statusFresh?: boolean },
): {
  reason: string;
  action?: string;
  source?: string;
  notify?: boolean;
  latch?: boolean;
  scheduleKey?: string;
};
export function nextSchedule(rule: Rule, now: Date): Instance["schedule"];
