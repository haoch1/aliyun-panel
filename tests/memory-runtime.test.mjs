import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AliyunGateway } from "../server/aliyun.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const account = {
  id: "memory-test",
  site: "international",
  credentials: { accessKeyId: "fixture-id", accessKeySecret: "fixture-secret" },
};
const subprocess = (code, env = {}) =>
  execute(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: { ...process.env, ...env },
    timeout: 10000,
    windowsHide: true,
  });

test("加载后端不加载云产品 SDK，仅按实际请求加载且复用官方客户端", async () => {
  const { stdout } = await subprocess(`
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {AliyunGateway} from './server/aliyun.mjs';
    import './server/app.mjs';
    const require=createRequire(import.meta.url);
    const products=['ecs20140526','vpc20160428','bssopenapi20171214','cdt20210813','sts20150401'];
    const loaded=()=>products.filter(p=>require.cache[require.resolve('@alicloud/'+p)]);
    assert.deepEqual(loaded(),[]);
    const account=${JSON.stringify(account)};
    const gateway=new AliyunGateway({account:()=>account});
    const client=gateway.client('ecs',account,'cn-hongkong');
    assert.deepEqual(loaded(),['ecs20140526']);
    assert.equal(gateway.client('ecs',account,'cn-hongkong'),client);
    client.callApi=async()=>({body:{TotalCount:0,Instances:{Instance:[]}}});
    assert.deepEqual(await gateway.instances(account.id,'cn-hongkong'),[]);
    assert.deepEqual(loaded(),['ecs20140526']);
    console.log('lazy SDK verified');
  `);
  assert.match(stdout, /lazy SDK verified/);
});

test("健康检查成功和失败返回正确状态，不加载后端或访问数据库", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-memory-"));
  const data = join(dir, "must-not-exist");
  let status = 200;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/api/health");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: status === 200 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep) &&
        basename(dir).startsWith("aliyun-memory-"),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const probe = `
    import {registerHooks} from 'node:module';
    registerHooks({load(url,context,next){
      if(url.includes('/server/')&&!url.endsWith('/runtime-identity.mjs'))
        throw Error('Health probe loaded backend: '+url);
      return next(url,context);
    }});
    process.argv.push('--healthcheck');
    await import('./bin/aliyun-panel.mjs');
  `;
  const env = { PORT: String(server.address().port), DATA_DIR: data };
  await subprocess(probe, env);
  assert.equal(existsSync(data), false);
  status = 503;
  await assert.rejects(subprocess(probe, env), (error) => error.code === 1);
  assert.equal(existsSync(data), false);
});

test("过期接口缓存自动回收，重复查询和入出站并发继续去重", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const store = { onClose: new Set() };
  const gateway = new AliyunGateway(store);
  t.after(() => {
    for (const stop of store.onClose) stop();
  });
  let calls = 0;
  const read = async () => ++calls;
  assert.deepEqual(
    await Promise.all([
      gateway.cached("in-out", 15000, read),
      gateway.cached("in-out", 15000, read),
    ]),
    [1, 1],
  );
  assert.equal(await gateway.cached("in-out", 15000, read), 1);
  t.mock.timers.tick(30000);
  assert.equal(gateway.cache.size, 0);
  assert.equal(await gateway.cached("in-out", 15000, read), 2);
});

test("多区间缓存有界，淘汰后可重查，失效前的迟到结果不能覆盖新值", async () => {
  const gateway = new AliyunGateway({});
  await gateway.cached("recent", 3600000, async () => "keep");
  for (let i = 0; i < 300; i++) {
    await gateway.cached("range-" + i, 3600000, async () => i);
    assert.equal(
      await gateway.cached("recent", 3600000, async () => "bad"),
      "keep",
    );
  }
  assert.ok(gateway.cache.size <= 128);
  assert.equal(
    await gateway.cached("range-0", 3600000, async () => "reload"),
    "reload",
  );
  let finish;
  const old = gateway.cached(
    "late",
    1000,
    () => new Promise((r) => (finish = r)),
  );
  gateway.invalidate();
  assert.equal(await gateway.cached("late", 1000, async () => "new"), "new");
  finish("old");
  assert.equal(await old, "old");
  assert.equal(await gateway.cached("late", 1000, async () => "bad"), "new");
});

test("客户端缓存有界，凭证隔离与最近使用客户端复用保持正常", () => {
  const gateway = new AliyunGateway({});
  const active = gateway.client("sts", account, "cn-hangzhou");
  for (let i = 0; i < 150; i++) {
    gateway.client("sts", { ...account, id: "account-" + i }, "cn-hangzhou");
    assert.equal(gateway.client("sts", account, "cn-hangzhou"), active);
  }
  assert.ok(gateway.clients.size <= 128);
  const rotated = gateway.client(
    "sts",
    {
      ...account,
      credentials: { ...account.credentials, accessKeySecret: "new" },
    },
    "cn-hangzhou",
  );
  assert.notEqual(rotated, active);
  gateway.invalidate();
  assert.equal(gateway.clients.size, 0);
});

test("重复轮询复用时区格式器，夏令时与跨月结果仍实时计算", async () => {
  await subprocess(`
    import assert from 'node:assert/strict';
    const Original=Intl.DateTimeFormat;
    let constructions=0;
    Intl.DateTimeFormat=function(...args){constructions++;return new Original(...args);};
    const {zoned,clockDue,nextSchedule}=await import('./shared/policy.mjs');
    for(let i=0;i<300;i++) {
      clockDue(new Date('2026-10-21T00:30:00Z'),'Asia/Shanghai','00:00');
      zoned(new Date('2026-03-08T07:00:00Z'),'America/New_York');
    }
    assert.ok(constructions<=4,'Polling recreated ICU formatters');
    assert.equal(zoned(new Date('2026-03-08T06:59:00Z'),'America/New_York').clock,'01:59');
    assert.equal(zoned(new Date('2026-03-08T07:00:00Z'),'America/New_York').clock,'03:00');
    assert.equal(zoned(new Date('2026-10-31T15:59:00Z'),'Asia/Shanghai').month,'2026-10');
    assert.equal(zoned(new Date('2026-10-31T16:00:00Z'),'Asia/Shanghai').month,'2026-11');
    assert.equal(nextSchedule({scheduleEnabled:true,timezone:'Asia/Shanghai',start:'08:00',stop:'23:00'},new Date('2026-10-21T00:00:00Z')).nextAt,'2026-10-21T15:00:00.000Z');
  `);
});
