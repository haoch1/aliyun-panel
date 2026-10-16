import Select from "./components/ui/Select";
import { createResourceCache } from "./resource-cache";
import {
  formatDate,
  groupDataTimes,
  type DataTime,
} from "../shared/presentation";
import {
  cloneElement,
  isValidElement,
  createContext,
  useContext,
  useEffect,
  useState,
  useId,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import type {
  Account,
  Instance,
  Settings,
  Snapshot,
  Rule,
} from "../shared/types";
let csrf = "";
const queryCache = createResourceCache();
export const isDemo = () =>
  new URLSearchParams(location.search).get("demo") === "1";
export const setCsrf = (v: string) => {
  if (csrf !== v) {
    queryCache.clear();
  }
  csrf = v;
};
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  if (isDemo()) {
    const { demoApi } = await import("./demo");
    return demoApi(path, body, method);
  }
  const r = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(["GET", "HEAD"].includes(method) ? {} : { "x-csrf-token": csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await r
    .json()
    .catch(() => ({ error: "服务器没有返回有效数据" }));
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event("auth-revoked"));
    throw new Error(value.error || "请求失败");
  }
  return value;
}
export function useData<T>(
  path: string | null,
  revision = 0,
  cache = true,
  scope = "",
) {
  const cacheKey = (isDemo() ? "demo:" : "real:") + path + scope;
  const epoch = queryCache.version;
  const cached = useSyncExternalStore(
    (listener) => queryCache.subscribe(cacheKey, listener),
    () => (cache ? queryCache.get<T>(cacheKey) : undefined),
  );
  const [state, setState] = useState(() => ({
    path: cacheKey,
    epoch,
    data: cache ? queryCache.get<T>(cacheKey) : undefined,
    error: "",
    loading: Boolean(path),
  }));
  useEffect(() => {
    if (!path) return;
    let active = true;
    setState((old) => ({
      path: cacheKey,
      epoch,
      data:
        old.path === cacheKey && old.epoch === epoch
          ? old.data
          : cache
            ? queryCache.get<T>(cacheKey)
            : undefined,
      error: "",
      loading: true,
    }));
    const request = cache
      ? queryCache.request<T>(cacheKey, () => api<T>(path), revision)
      : api<T>(path);
    request
      .then((d) => {
        if (active && epoch === queryCache.version) {
          setState({
            path: cacheKey,
            epoch,
            data: d,
            error: "",
            loading: false,
          });
        }
      })
      .catch((e) => {
        if (active && epoch === queryCache.version)
          setState((old) => ({ ...old, error: e.message, loading: false }));
      });
    return () => {
      active = false;
    };
  }, [path, revision, cache, cacheKey, epoch]);
  const matches = state.path === cacheKey && state.epoch === epoch;
  const data = !path
    ? undefined
    : matches
      ? (cached ?? state.data)
      : cache
        ? queryCache.get<T>(cacheKey)
        : undefined;
  const error =
    path && matches && (cached === undefined || cached === state.data)
      ? state.error
      : "";
  const loading = Boolean(path) && (!matches || state.loading);
  return {
    data,
    error,
    loading,
    initialLoading: Boolean(path) && data === undefined && !error,
  };
}
export const bytes = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v)
    ? "未知"
    : v >= 1024 ** 3
      ? (v / 1024 ** 3).toFixed(2) + " GB"
      : v >= 1024 ** 2
        ? (v / 1024 ** 2).toFixed(1) + " MB"
        : Math.round(v / 1024) + " KB";
export const date = formatDate;
export function DataTimes({ entries }: { entries: DataTime[] }) {
  return (
    <>
      {groupDataTimes(entries).map((g) => (
        <span key={g.text}>
          {g.labels.join(" / ")} {g.text}
        </span>
      ))}
    </>
  );
}
export function RefreshTime({
  value,
  entries = [],
}: {
  value?: number | string;
  entries?: DataTime[];
}) {
  const detail = groupDataTimes(entries)
    .map((g) => g.labels.join(" / ") + " " + g.text)
    .join("\n");
  return (
    <span title={detail}>刷新时间 {value ? date(value) : "尚未刷新"}</span>
  );
}
export const target = (i: Instance) => ({
  accountId: i.accountId,
  region: i.region,
  id: i.id,
});
export const ruleFields = (r: Rule) =>
  Object.fromEntries(
    [
      "keepAlive",
      "paused",
      "thresholdEnabled",
      "thresholdPercent",
      "thresholdAction",
      "thresholdUnit",
      "thresholdGiB",
      "autoRecover",
      "stoppedMode",
      "scheduleStopEnabled",
      "scheduleEnabled",
      "start",
      "stop",
      "timezone",
    ].map((k) => [k, r[k as keyof Rule]]),
  );
export const key = (i: Instance) =>
  JSON.stringify([i.accountId, i.region, i.id]);
export interface PanelState {
  accounts: Account[];
  snapshot: Snapshot;
  settings: Settings | undefined;
  revision: number;
  loading: boolean;
  initialLoading: boolean;
  refresh: () => void;
  notice: (message: string, error?: boolean) => void;
  select: (page: string, i?: Instance) => void;
  selected: string;
}
export const PanelContext = createContext<PanelState>(null!);
export const usePanel = () => useContext(PanelContext);
export function ErrorBox({ error }: { error?: string }) {
  return error ? (
    <div className="error-box" role="alert">
      {error}
    </div>
  ) : null;
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<any>, {
            id,
            "aria-describedby": hint ? id + "-hint" : undefined,
          })
        : children}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={"switch " + (checked ? "checked" : "")}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
export function InstanceSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { snapshot } = usePanel();
  return (
    <Select
      aria-label="选择实例"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">选择实例</option>
      {snapshot.items.map((i) => (
        <option key={key(i)} value={key(i)}>
          {i.name}
        </option>
      ))}
    </Select>
  );
}
export function useInstance() {
  const p = usePanel();
  const [choice, setChoice] = useState({
    external: p.selected,
    value: p.selected || "",
  });
  const chosen = choice.external === p.selected ? choice.value : p.selected;
  const setValue = (value: string) =>
    setChoice({ external: p.selected, value });
  const instance =
    p.snapshot.items.find((i) => key(i) === chosen) || p.snapshot.items[0];
  const value = instance ? key(instance) : "";
  return { value, setValue, instance };
}
