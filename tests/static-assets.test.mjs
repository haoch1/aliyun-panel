import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { fixture } from "./fixture.mjs";

test("静态资源丢失时返回 404，页面回退仍支持前端路由", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aliyun-assets-"));
  const dist = join(dir, "dist"),
    runtime = fixture(dir);
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!--panel-bootstrap--><main>panel</main>",
  );
  writeFileSync(join(dist, "assets", "entry.js"), "void 0");
  writeFileSync(join(dist, "assets", "entry.js.gz"), gzipSync("void 0"));
  runtime.store.setPassword("fixture-login-password");
  const session = runtime.store.createSession();
  const server = createApp(runtime, { dist }).listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    for (const entry of ["/", "/index.html", "/instances"]) {
      const response = await fetch(base + entry);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(await response.text(), /<main>panel/);
    }
    assert.match(
      (await fetch(base + "/assets/entry.js")).headers.get("cache-control"),
      /immutable/,
    );
    const zipped = await fetch(base + "/assets/entry.js", {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(zipped.headers.get("content-encoding"), "gzip");
    assert.match(zipped.headers.get("vary"), /Accept-Encoding/i);
    assert.equal(await zipped.text(), "void 0");
    const identity = await fetch(base + "/assets/entry.js", {
      headers: { "Accept-Encoding": "gzip;q=0, identity" },
    });
    assert.equal(identity.headers.get("content-encoding"), null);
    assert.equal(await identity.text(), "void 0");
    const bootstrap = async (headers) => {
      const response = await fetch(base + "/audit", { headers });
      const html = await response.text();
      assert.ok(!html.includes(session.token));
      return JSON.parse(
        html.match(
          /<script id="panel-bootstrap" type="application\/json">(.*?)<\/script>/s,
        )[1],
      );
    };
    assert.deepEqual(await bootstrap(), {
      initialized: true,
      authenticated: false,
      testMode: false,
    });
    const headers = { cookie: "aliyun_panel_session=" + session.token };
    const signedIn = await bootstrap(headers);
    assert.equal(signedIn.authenticated, true);
    assert.equal(signedIn.csrf, session.csrf);
    assert.equal(signedIn.expires, session.expires);
    const missing = await fetch(base + "/assets/old.js");
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type"), /text\/plain/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
