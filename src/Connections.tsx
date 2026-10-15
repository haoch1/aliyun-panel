import {
  commonRegions,
  regionName,
  type RegionOption,
} from "../shared/regions";
import { useEffect, useState } from "react";
import type { Account, Instance } from "../shared/types";
import { api, ErrorBox, Field, isDemo, target, usePanel } from "./lib";
import Select from "./components/ui/Select";
import { Modal } from "./components/ui/Modal";
import { PendingButton } from "./components/ui/PendingButton";
import { DataRegion, LoadingForm } from "./components/ui/DataRegion";
interface Candidate {
  id: string;
  name: string;
  region: string;
  status: string;
  ip: string[];
}
export default function ConnectionDialog({
  account,
  instance,
  onClose,
}: {
  account?: Account;
  instance?: Instance;
  onClose: () => void;
}) {
  const p = usePanel();
  const [form, setForm] = useState({
    name: instance?.name || "",
    accessKeyId: isDemo() ? "DEMO-ACCESSKEY" : "",
    accessKeySecret: isDemo() && !account ? "demo-only-secret" : "",
    site: account?.site || "china",
    region: instance?.region || account?.region || "",
    instanceId: instance?.id || "",
  });
  const [scan, setScan] = useState<{
    token: string;
    items: Candidate[];
    errors: string[];
    regions?: RegionOption[];
  }>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [regions, setRegions] = useState<RegionOption[]>(commonRegions);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [ready, setReady] = useState(!account);
  useEffect(() => {
    if (!account) return;
    let active = true;
    api("/connections/" + account.id)
      .then((a) => {
        if (active) {
          setForm((f) => ({
            ...f,
            accessKeyId: a.accessKeyId,
            site: a.site,
            region: a.region,
          }));
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [account?.id]);
  const displayName = (i: Candidate) =>
    names[i.region + "|" + i.id] ??
    (selected.length === 1 &&
    selected.includes(i.region + "|" + i.id) &&
    form.name.trim()
      ? form.name.trim()
      : i.name);
  const set = (key: string, value: string) => {
    setForm({ ...form, [key]: value });
    if (key !== "name") {
      setScan(undefined);
      setSelected([]);
      setNames({});
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (account) {
        const { instanceId, ...data } = form;
        await api(
          "/connections/" + account.id,
          {
            ...data,
            name: account.name,
            ...(instance
              ? { instance: { target: target(instance), name: form.name } }
              : {}),
          },
          "PUT",
        );
        p.refresh();
        p.notice("实例设置已更新");
        onClose();
      } else {
        const result = await api("/connections/discover", {
          ...form,
          name: form.name.trim(),
        });
        if (result.regions?.length) setRegions(result.regions);
        setNames({});
        setScan(result);
        setSelected(
          result.items.length === 1
            ? [result.items[0].region + "|" + result.items[0].id]
            : [],
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const importSelected = async () => {
    if (!scan || !selected.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const targets = scan.items
        .filter((i) => selected.includes(i.region + "|" + i.id))
        .map((i) => ({
          region: i.region,
          id: i.id,
          name: displayName(i).trim(),
        }));
      if (targets.some((t) => !t.name)) throw new Error("请填写所选实例的名称");
      const result = await api("/connections/import", {
        token: scan.token,
        targets,
        keepAlive: true,
      });
      p.refresh();
      p.notice(
        `已添加 ${result.added} 台实例${result.existing ? `，${result.existing} 台已存在` : ""}`,
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={account ? "编辑实例" : "添加实例"}
      onClose={onClose}
      busy={busy}
      wide={!!scan}
    >
      <DataRegion pending={!ready && !error} placeholder={<LoadingForm />}>
        {!ready ? (
          <>
            <ErrorBox error={error} />
          </>
        ) : (
          <form className="form-stack connection-form" onSubmit={submit}>
            {isDemo() && (
              <div className="info-box">
                演示凭证仅用于模拟发现，不会验证或保存真实 AccessKey
              </div>
            )}
            <div className="form-grid">
              <Field label="AccessKey ID" hint="填写账号的 AccessKey ID">
                <input
                  required
                  autoComplete="off"
                  value={form.accessKeyId}
                  disabled={busy}
                  onChange={(e) => set("accessKeyId", e.target.value)}
                />
              </Field>
              <Field
                label="AccessKey Secret"
                hint={
                  account
                    ? "留空保留已保存的 Secret"
                    : "填写与 ID 配对的 Secret"
                }
              >
                <input
                  type="password"
                  required={!account}
                  autoComplete="off"
                  value={form.accessKeySecret}
                  disabled={busy}
                  onChange={(e) => set("accessKeySecret", e.target.value)}
                />
              </Field>
              <Field label="账号所属站点" hint="按账号所属站点选择">
                <Select
                  value={form.site}
                  disabled={busy}
                  onChange={(e) => set("site", e.target.value)}
                >
                  <option value="china">国内站</option>
                  <option value="international">国际站</option>
                </Select>
              </Field>
              <Field label="实例名称" hint="设置此实例的显示名称">
                <input
                  required
                  maxLength={80}
                  value={form.name}
                  disabled={busy}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              <Field label="地域" hint="选择实例所在地域">
                <Select
                  aria-label="地域"
                  value={form.region}
                  disabled={busy}
                  onChange={(e) => set("region", e.target.value)}
                >
                  {!account && <option value="">自动识别地域</option>}
                  {regions.map((r) => (
                    <option key={r.regionId} value={r.regionId}>
                      {r.localName || regionName(r.regionId)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="实例 ID" hint="从 ECS 控制台复制实例 ID">
                <input
                  required
                  readOnly={!!account}
                  placeholder="i-…"
                  value={form.instanceId}
                  disabled={busy}
                  onChange={(e) => set("instanceId", e.target.value)}
                />
              </Field>
            </div>
            <ErrorBox error={error} />
            {!scan && (
              <div className="form-actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={onClose}
                >
                  取消
                </button>
                <PendingButton
                  type="submit"
                  disabled={!ready}
                  busy={busy}
                  pendingLabel={account ? "正在保存" : "正在查询"}
                >
                  {account ? "保存" : "查询实例"}
                </PendingButton>
              </div>
            )}
            {scan && (
              <>
                <div className="section-heading">
                  <h2>选择要监控的实例</h2>
                  <span className="muted">
                    已选 {selected.length} / {scan.items.length}
                  </span>
                </div>
                <small className="muted">
                  {scan.items.length > 1
                    ? "查询到多台实例，请勾选并分别确认名称；上方名称仅在选中一台时使用"
                    : "确认名称后添加；名称仅用于面板显示"}
                </small>
                {!!scan.errors.length && (
                  <details className="discovery-warnings">
                    <summary>
                      {scan.items.length ? "已找到实例；" : ""}
                      {scan.errors.length} 个地域暂未查询成功
                    </summary>
                    <ul>
                      {scan.errors.map((message, index) => (
                        <li key={index}>{message}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <div
                  className="table-wrap discovery-table"
                  tabIndex={0}
                  role="region"
                  aria-label="发现结果，可横向滚动"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <input
                            aria-label="选择全部发现实例"
                            type="checkbox"
                            checked={
                              !!scan.items.length &&
                              selected.length === scan.items.length
                            }
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? scan.items.map((i) => i.region + "|" + i.id)
                                  : [],
                              )
                            }
                          />
                        </th>
                        <th>实例</th>
                        <th>地域</th>
                        <th>状态</th>
                        <th>公网 IP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scan.items.map((i) => {
                        const key = i.region + "|" + i.id;
                        return (
                          <tr key={key}>
                            <td>
                              <input
                                aria-label={"选择 " + i.name}
                                type="checkbox"
                                checked={selected.includes(key)}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? [...selected, key]
                                      : selected.filter((x) => x !== key),
                                  )
                                }
                              />
                            </td>
                            <td className="discovery-name">
                              <input
                                aria-label={i.name + " 实例名称"}
                                value={displayName(i)}
                                maxLength={80}
                                disabled={busy}
                                onChange={(e) =>
                                  setNames({ ...names, [key]: e.target.value })
                                }
                              />
                              <div className="subline mono">{i.id}</div>
                            </td>
                            <td title={i.region}>{regionName(i.region)}</td>
                            <td>
                              {i.status === "Running"
                                ? "运行中"
                                : i.status === "Stopped"
                                  ? "已停止"
                                  : i.status}
                            </td>
                            <td>{i.ip.join(", ") || "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!scan.items.length && (
                    <p className="empty">没有发现可添加的实例</p>
                  )}
                </div>
                <small className="muted">
                  添加后默认启用保活，可在实例页面关闭；会按规则启动符合条件的已停止实例
                </small>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => setScan(undefined)}
                  >
                    重新填写
                  </button>
                  <PendingButton
                    busy={busy}
                    disabled={!selected.length}
                    pendingLabel="正在添加"
                    onClick={importSelected}
                  >
                    添加所选实例
                  </PendingButton>
                </div>
              </>
            )}
          </form>
        )}
      </DataRegion>
    </Modal>
  );
}
