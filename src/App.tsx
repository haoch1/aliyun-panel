import { Sidebar } from "./components/ui/Sidebar";
import { Input } from "./components/ui/Input";
import { Form } from "./components/ui/Form";
import { usePasswordManagerPolicy } from "./components/ui/usePasswordManagerPolicy";
import { ThemeControl } from "./theme";
import Select from "./components/ui/Select";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { eventGroups, type RefreshGroup } from "./resource-events";
import { sortByName } from "../shared/resource-order";
import {
  ArrowDownUp,
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CreditCard,
  Eye,
  FileText,
  LogOut,
  Menu,
  Server,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { BrandMark } from "./components/ui/BrandMark";
import type { Account, Settings, Snapshot, Instance } from "../shared/types";
import {
  api,
  ErrorBox,
  PanelContext,
  setCsrf,
  useData,
  key,
  isDemo,
  Field,
} from "./lib";
import Instances from "./Instances";
import { Traffic } from "./Resources";
import Billing from "./Billing";
import { PendingButton } from "./components/ui/PendingButton";
import Logs from "./Logs";
import { Tooltip } from "./components/ui/Tooltip";
import { DataRegion, PageLoading } from "./components/ui/DataRegion";
import { LoadingRegion } from "./components/ui/Skeleton";
const SettingsPage = lazy(() => import("./Settings"));

interface SessionInfo {
  initialized: boolean;
  authenticated: boolean;
  csrf?: string;
  expires?: number;
  testMode?: boolean;
}
const nav = [
  ["instances", "实例管理", Server],
  ["traffic", "流量统计", ArrowDownUp],
  ["billing", "账单与余额", CreditCard],
  ["audit", "运行日志", FileText],
  ["settings", "系统设置", SlidersHorizontal],
] as const;
const empty: Snapshot = { items: [], at: 0, errors: [], refreshing: false };
const currentPage = () => {
  const page = location.pathname.slice(1);
  return nav.find((n) => n[0] === page)?.[0] || "instances";
};
const initialPage = currentPage();
function initialAuth(): SessionInfo | undefined {
  if (isDemo()) return;
  const node = document.getElementById("panel-bootstrap");
  if (!node) return;
  node.remove();
  try {
    const auth: SessionInfo = JSON.parse(node.textContent || "");
    if (
      typeof auth.initialized === "boolean" &&
      typeof auth.authenticated === "boolean" &&
      (!auth.authenticated ||
        (typeof auth.csrf === "string" && (auth.expires || 0) > Date.now()))
    ) {
      setCsrf(auth.csrf || "");
      return auth;
    }
  } catch {
    // Static hosting and older deployments can use the auth endpoint.
  }
}
const bootstrap = initialAuth();
if (location.pathname !== `/${initialPage}` || location.hash)
  history.replaceState(null, "", `/${initialPage}${location.search}`);
export default function App() {
  const [auth, setAuth] = useState(bootstrap);
  usePasswordManagerPolicy(auth?.authenticated === false);
  const [authError, setAuthError] = useState("");
  const [revision, setRevision] = useState(0);
  const [groupRevisions, setGroupRevisions] = useState<
    Partial<Record<RefreshGroup, number>>
  >({});
  const currentRevision = (group: RefreshGroup) =>
    revision + (groupRevisions[group] || 0);
  const [page, setPage] = useState(initialPage);
  const [selected, setSelected] = useState("");
  const [mobile, setMobile] = useState(false);
  const [notices, setNotices] = useState<
    { id: number; message: string; error: boolean }[]
  >([]);

  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const notice = useCallback((message: string, error = false) => {
    const id = Date.now() + Math.random();
    setNotices((v) => [
      ...v.filter((n) => n.message !== message).slice(-2),
      { id, message, error },
    ]);
    setTimeout(
      () => setNotices((v) => v.filter((n) => n.id !== id)),
      error ? 8000 : 3200,
    );
  }, []);
  const loadAuth = useCallback(() => {
    setAuthError("");
    return api<SessionInfo>("/auth")
      .then((v) => {
        setCsrf(v.csrf || "");
        setAuth(v);
        setAuthError("");
      })
      .catch((e) => setAuthError(e.message));
  }, []);
  useEffect(() => {
    if (!bootstrap) void loadAuth();
    window.addEventListener("auth-revoked", loadAuth);
    return () => window.removeEventListener("auth-revoked", loadAuth);
  }, [loadAuth]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    const handler = () => {
      setPage(currentPage());
      setMobile(false);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);
  useEffect(() => {
    if (!auth?.authenticated) return;
    if (isDemo()) {
      let disposed = false;
      let stopAutomation: (() => void) | undefined;
      import("./demo").then(({ startDemoAutomation }) => {
        if (!disposed) stopAutomation = startDemoAutomation();
      });
      window.addEventListener("demo-changed", refresh);
      const poll = setInterval(refresh, 30000);
      return () => {
        disposed = true;
        stopAutomation?.();
        window.removeEventListener("demo-changed", refresh);
        clearInterval(poll);
      };
    }
    const es = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connected = false;
    let lastReconcile = Date.now();
    const reconcile = () => {
      lastReconcile = Date.now();
      refresh();
    };
    const pending = new Set<RefreshGroup>();
    es.onopen = () => {
      if (connected && !document.hidden) reconcile();
      connected = true;
    };
    es.onmessage = ({ data }) => {
      if (document.hidden) return;
      for (const group of eventGroups(data)) pending.add(group);
      if (!pending.size || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        const batch = [...pending];
        pending.clear();
        setGroupRevisions((old) => {
          const next = { ...old };
          for (const group of batch) next[group] = (old[group] || 0) + 1;
          return next;
        });
      }, 300);
    };
    const poll = setInterval(() => {
      if (
        !document.hidden &&
        (es.readyState !== EventSource.OPEN ||
          Date.now() - lastReconcile >= 120000)
      )
        reconcile();
    }, 30000);
    const resume = () => {
      if (!document.hidden) reconcile();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      es.close();
      document.removeEventListener("visibilitychange", resume);
      clearInterval(poll);
      clearTimeout(timer);
    };
  }, [auth?.authenticated, refresh]);
  const accounts = useData<{ items: Account[] }>(
    auth?.authenticated && (page === "instances" || page === "billing")
      ? "/accounts"
      : null,
    currentRevision("accounts"),
  );
  const data = useData<Snapshot>(
    auth?.authenticated && page !== "settings"
      ? page === "instances"
        ? "/instances"
        : "/instances?summary=1"
      : null,
    page === "instances"
      ? currentRevision("instances")
      : revision + (groupRevisions.traffic || 0),
  );
  const settings = useData<Settings>(
    auth?.authenticated && (page === "settings" || page === "billing")
      ? "/settings"
      : null,
    currentRevision("settings"),
  );
  const snapshot = useMemo(
    () =>
      data.data ? { ...data.data, items: sortByName(data.data.items) } : empty,
    [data.data],
  );
  const orderedAccounts = useMemo(
    () => sortByName(accounts.data?.items || []),
    [accounts.data],
  );
  const initialLoading =
    (!auth && !authError) ||
    (page === "instances" &&
      (data.initialLoading ||
        (accounts.initialLoading && !snapshot.items.length))) ||
    (page === "traffic" && data.initialLoading) ||
    (page === "settings" && settings.initialLoading);
  const select = (p: string, i?: Instance) => {
    const next = nav.find(([route]) => route === p)?.[0];
    if (!next) return;
    if (i) setSelected(key(i));
    if (page !== next)
      history.pushState(null, "", `/${next}${location.search}`);
    setPage(next);
    setMobile(false);
  };
  const logout = async () => {
    try {
      await api("/logout", {});
      await loadAuth();
    } catch (e) {
      notice((e as Error).message, true);
    }
  };
  if (auth && !auth.authenticated)
    return (
      <Auth
        initialized={auth.initialized}
        onDone={(session) =>
          setAuth({
            ...auth,
            ...session,
            initialized: true,
            authenticated: true,
          })
        }
      />
    );
  return (
    <PanelContext.Provider
      value={{
        accounts: orderedAccounts,
        snapshot,
        loading: data.loading,
        initialLoading,
        settings: settings.data,
        revision:
          page === "instances"
            ? currentRevision("traffic") + (groupRevisions.billing || 0)
            : currentRevision(page),
        refresh,
        notice,
        select,
        selected,
      }}
    >
      <div className="app-shell">
        <Sidebar open={mobile} onOpenChange={setMobile} id="main-navigation">
          <a
            className="brand"
            href={"/instances" + location.search}
            onClick={(event) => {
              if (
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              select("instances");
            }}
          >
            <BrandMark variant="aliyun" />
            <span className="brand-text">
              <strong>Aliyun Panel</strong>
            </span>
          </a>
          <button
            className="mobile-close icon-button"
            aria-label="关闭导航"
            onClick={() => setMobile(false)}
          >
            <X />
          </button>
          <nav>
            {nav.map(([p, label, Icon]) => (
              <button
                key={p}
                className={page === p ? "active" : ""}
                aria-current={page === p ? "page" : undefined}
                onClick={() => select(p)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <ThemeControl compact />
            {auth?.authenticated && !isDemo() && (
              <button type="button" className="sidebar-logout" onClick={logout}>
                <LogOut size={15} />
                <span>退出登录</span>
              </button>
            )}
          </div>
        </Sidebar>
        <div className="workspace">
          <header className="topbar">
            <div className="topbar-left">
              <button
                className="mobile-menu icon-button"
                aria-label="打开导航"
                aria-expanded={mobile}
                aria-controls="main-navigation"
                onClick={() => setMobile(true)}
              >
                <Menu />
              </button>
              <div className="breadcrumb" aria-label="当前位置">
                <span>控制台</span>
                <ChevronRight size={13} />
                <strong>{nav.find((n) => n[0] === page)?.[1]}</strong>
              </div>
              <span className="mobile-page-title">
                {nav.find((n) => n[0] === page)?.[1]}
              </span>
            </div>
            {isDemo() && (
              <div className="topbar-actions">
                <Tooltip content="所有数据和操作均为本地示例">
                  <span className="demo-indicator" tabIndex={0}>
                    演示模式
                  </span>
                </Tooltip>
                <a className="demo-exit" href="/">
                  退出演示
                  <ArrowUpRight size={13} />
                </a>
              </div>
            )}
          </header>
          <main>
            {auth?.testMode && !isDemo() && (
              <div className="test-banner">
                测试环境：云端调用已模拟，本页操作不会修改真实资源
              </div>
            )}
            <ErrorBox error={accounts.error || data.error || settings.error} />
            {!auth && authError && (
              <div className="panel-connection-error" role="alert">
                <h1>暂时无法连接面板</h1>
                <ErrorBox error={authError} />
                <button className="button" onClick={loadAuth}>
                  重新连接
                </button>
              </div>
            )}
            <DataRegion
              pending={initialLoading}
              placeholder={<PageLoading page={page} />}
            >
              {auth?.authenticated &&
                (page === "instances" ? (
                  <Instances />
                ) : page === "traffic" ? (
                  <Traffic />
                ) : page === "billing" ? (
                  <Billing />
                ) : page === "settings" ? (
                  <Suspense
                    fallback={
                      <LoadingRegion label="正在加载系统设置">
                        <PageLoading page="settings" />
                      </LoadingRegion>
                    }
                  >
                    <SettingsPage />
                  </Suspense>
                ) : (
                  <Logs />
                ))}
            </DataRegion>
          </main>
        </div>
        <div className="notices" aria-live="polite">
          {notices.map((n) => (
            <div key={n.id} className={"notice " + (n.error ? "error" : "")}>
              {n.error ? (
                <CircleAlert
                  className="notice-icon"
                  size={17}
                  aria-hidden="true"
                />
              ) : (
                <CircleCheck
                  className="notice-icon"
                  size={17}
                  aria-hidden="true"
                />
              )}
              <span>{n.message}</span>
              <button
                className="icon-button"
                aria-label="关闭提示"
                onClick={() =>
                  setNotices((v) => v.filter((x) => x.id !== n.id))
                }
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </PanelContext.Provider>
  );
}
function Auth({
  initialized,
  onDone,
}: {
  initialized: boolean;
  onDone: (session: { csrf: string; expires: number }) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hours, setHours] = useState(720);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!initialized && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const v = await api<{ csrf: string; expires: number }>(
        initialized ? "/login" : "/setup",
        {
          password,
          sessionHours: hours,
        },
      );
      setCsrf(v.csrf);
      onDone(v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark variant="aliyun" size={34} />
          <strong>Aliyun Panel</strong>
        </div>
        <h1>{initialized ? "登录" : "初始化"}</h1>
        <Form allowPasswordManager onSubmit={submit}>
          <Field label="管理员密码">
            <Input
              allowPasswordManager
              aria-label="管理员密码"
              type="password"
              name="password"
              placeholder={initialized ? undefined : "至少 12 位"}
              minLength={initialized ? 1 : 12}
              required
              autoComplete={initialized ? "current-password" : "new-password"}
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {!initialized && (
            <Field label="确认密码">
              <Input
                allowPasswordManager
                type="password"
                name="password-confirmation"
                minLength={12}
                required
                autoComplete="new-password"
                disabled={busy}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
          )}
          <Field label="登录有效期">
            <Select
              aria-label="登录有效期"
              disabled={busy}
              value={hours}
              onChange={(e) => setHours(+e.target.value)}
            >
              {[
                [12, "12 小时"],
                [24, "1 天"],
                [168, "7 天"],
                [720, "30 天"],
                [2160, "90 天"],
              ].map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorBox error={error} />
          <PendingButton
            type="submit"
            className="button primary full"
            busy={busy}
            pendingLabel={initialized ? "正在登录" : "正在初始化"}
          >
            {initialized ? "登录" : "初始化面板"}
          </PendingButton>
        </Form>
        <a className="demo-entry" href="/instances?demo=1">
          <Eye size={15} />
          先预览演示面板
          <ArrowUpRight size={14} />
        </a>
        <ThemeControl />
      </div>
    </div>
  );
}
