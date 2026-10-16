import { ThemeControl } from "./theme";
import Select from "./components/ui/Select";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sortByName } from "../shared/resource-order";
import {
  ArrowUpRight,
  ArrowDownUp,
  Cloud,
  CircleCheck,
  CircleX,
  FlaskConical,
  LogOut,
  Menu,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  X,
} from "lucide-react";
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
import { ReceiptText } from "lucide-react";
import SettingsPage from "./Settings";
import { PendingButton } from "./components/ui/PendingButton";
import Logs from "./Logs";
import { DataRegion, PageLoading } from "./components/ui/DataRegion";
const nav = [
  ["instances", "Aliyun 实例", Cloud],
  ["traffic", "流量统计", ArrowDownUp],
  ["billing", "账单与余额", ReceiptText],
  ["audit", "日志", ScrollText],
  ["settings", "设置", SettingsIcon],
] as const;
const empty: Snapshot = { items: [], at: 0, errors: [], refreshing: false };
export default function App() {
  const [auth, setAuth] = useState<any>();
  const [authError, setAuthError] = useState("");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(
    nav.some((n) => n[0] === location.hash.slice(1))
      ? location.hash.slice(1)
      : "instances",
  );
  const [selected, setSelected] = useState("");
  const [mobile, setMobile] = useState(false);
  const [notices, setNotices] = useState<
    { id: number; message: string; error: boolean }[]
  >([]);

  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const notice = useCallback((message: string, error = false) => {
    const id = Date.now() + Math.random();
    setNotices((v) => [
      ...v.filter((n) => n.error && n.message !== message).slice(-1),
      { id, message, error },
    ]);
    setTimeout(
      () => setNotices((v) => v.filter((n) => n.id !== id)),
      error ? 8000 : 2000,
    );
  }, []);
  const loadAuth = useCallback(() => {
    setAuthError("");
    return api("/auth")
      .then((v) => {
        setCsrf(v.csrf || "");
        setAuth(v);
        setAuthError("");
      })
      .catch((e) => setAuthError(e.message));
  }, []);
  useEffect(() => {
    loadAuth();
    window.addEventListener("auth-revoked", loadAuth);
    return () => window.removeEventListener("auth-revoked", loadAuth);
  }, [loadAuth]);

  useEffect(() => {
    if (!mobile) return;
    const closeAtDesktop = () => {
      if (window.matchMedia("(min-width: 761px)").matches) setMobile(false);
    };
    closeAtDesktop();
    window.addEventListener("resize", closeAtDesktop);
    const previous = document.activeElement as HTMLElement;
    const sidebar = document.getElementById("main-navigation");
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const controls = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>("button, a[href]") || [],
      ).filter(
        (e) =>
          e.getClientRects().length &&
          getComputedStyle(e).visibility !== "hidden",
      );
    controls()
      .find((e) => e.classList.contains("active"))
      ?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMobile(false);
      }
      if (e.key !== "Tab") return;
      const items = controls(),
        first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last ||
          !sidebar?.contains(document.activeElement))
      ) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", closeAtDesktop);
      if (previous?.isConnected) previous.focus();
    };
  }, [mobile]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    const handler = () =>
      setPage(
        nav.some((n) => n[0] === location.hash.slice(1))
          ? location.hash.slice(1)
          : "instances",
      );
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
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
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    const poll = setInterval(refresh, 30000);
    return () => {
      es.close();
      clearInterval(poll);
      clearTimeout(timer);
    };
  }, [auth?.authenticated, refresh]);
  const accounts = useData<{ items: Account[] }>(
    auth?.authenticated ? "/accounts" : null,
    revision,
  );
  const data = useData<Snapshot>(
    auth?.authenticated ? "/instances" : null,
    revision,
  );
  const settings = useData<Settings>(
    auth?.authenticated ? "/settings" : null,
    revision,
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
    data.initialLoading ||
    accounts.initialLoading ||
    settings.initialLoading;
  const select = (p: string, i?: Instance) => {
    if (i) setSelected(key(i));
    setPage(p);
    location.hash = p;
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
    return <Auth initialized={auth.initialized} onDone={loadAuth} />;
  return (
    <PanelContext.Provider
      value={{
        accounts: orderedAccounts,
        snapshot,
        loading: data.loading,
        initialLoading,
        settings: settings.data,
        revision,
        refresh,
        notice,
        select,
        selected,
      }}
    >
      <div className="app-shell">
        {mobile && (
          <div className="mobile-backdrop" onClick={() => setMobile(false)} />
        )}
        <aside
          id="main-navigation"
          className={"sidebar " + (mobile ? "mobile-open" : "")}
          aria-label="主导航"
        >
          <a className="brand" href="#instances">
            <Cloud size={23} />
            <strong>Aliyun Panel</strong>
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
                <Icon size={18} />
                {label}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <ThemeControl compact />
          </div>
        </aside>
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
            </div>
            <div className="row">
              {auth?.authenticated && (
                <button
                  className="icon-button"
                  aria-label="退出登录"
                  onClick={logout}
                >
                  <LogOut size={18} />
                </button>
              )}
            </div>
          </header>
          {isDemo() && (
            <div className="demo-bar">
              <FlaskConical size={14} />
              <span>演示模式 · 所有数据和操作均为本地示例</span>
              <a href="/">
                退出演示，添加真实实例 <ArrowUpRight size={13} />
              </a>
            </div>
          )}
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
                  <SettingsPage />
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
                <CircleX className="notice-icon" size={19} aria-hidden="true" />
              ) : (
                <CircleCheck
                  className="notice-icon"
                  size={19}
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
  onDone: () => void;
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
      const v = await api(initialized ? "/login" : "/setup", {
        password,
        sessionHours: hours,
      });
      setCsrf(v.csrf);
      onDone();
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
          <Cloud size={27} />
          <strong>Aliyun Panel</strong>
        </div>
        <h1>{initialized ? "登录面板" : "初始化你的面板"}</h1>
        <p>
          {initialized
            ? "登录后管理实例与后台自动化"
            : "设置管理员密码，开始管理 ECS 实例"}
        </p>
        <form onSubmit={submit}>
          <Field
            label="管理员密码"
            hint={initialized ? undefined : "至少 12 位，无默认密码"}
          >
            <input
              aria-label="管理员密码"
              type="password"
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
              <input
                type="password"
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
            pendingLabel="正在登录"
          >
            {initialized ? "登录" : "初始化面板"}
          </PendingButton>
        </form>
        <a className="demo-entry" href="/?demo=1#instances">
          <FlaskConical size={15} />
          先预览演示面板
          <ArrowUpRight size={14} />
        </a>
        <div className="auth-foot">
          <ShieldCheck size={14} />
          凭证保存在你的服务器 · AES-256-GCM 加密
        </div>
        <ThemeControl />
      </div>
    </div>
  );
}
