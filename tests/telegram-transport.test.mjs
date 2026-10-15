import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { telegramRequest } from "../server/notify.mjs";

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}

function proxyEnvironment(t, values) {
  const keys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

test("TG 使用已配置的 HTTP 代理投递中文消息", async (t) => {
  let captured;
  const proxy = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => {
      captured = { url: req.url, data: JSON.parse(body) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  const proxyUrl = await listen(t, proxy);
  proxyEnvironment(t, { HTTP_PROXY: proxyUrl });
  await telegramRequest(
    { apiBase: "http://telegram.test.invalid", telegramToken: "fake-token" },
    { chat_id: "fake-chat", text: "保活成功" },
  );
  assert.equal(
    captured.url,
    "http://telegram.test.invalid/botfake-token/sendMessage",
  );
  assert.equal(captured.data.text, "保活成功");
});

test("TG HTTPS 请求通过 HTTPS_PROXY 建立 CONNECT 隧道", async (t) => {
  let target;
  const proxy = createServer();
  proxy.on("connect", (req, socket) => {
    target = req.url;
    socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
  });
  const proxyUrl = await listen(t, proxy);
  proxyEnvironment(t, { HTTPS_PROXY: proxyUrl });
  await assert.rejects(
    telegramRequest(
      { apiBase: "https://telegram.test.invalid", telegramToken: "fake-token" },
      { chat_id: "fake-chat", text: "保活成功" },
    ),
  );
  assert.equal(target, "telegram.test.invalid:443");
});

test("TG 尊重 NO_PROXY，本地 API 反代不经过外部代理", async (t) => {
  let proxied = 0;
  let delivered = 0;
  const proxyUrl = await listen(
    t,
    createServer((_req, res) => {
      proxied++;
      res.writeHead(502).end();
    }),
  );
  const apiBase = await listen(
    t,
    createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        delivered++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
    }),
  );
  proxyEnvironment(t, { HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" });
  await telegramRequest(
    { apiBase, telegramToken: "fake-token" },
    { chat_id: "fake-chat", text: "保活成功" },
  );
  assert.equal(delivered, 1);
  assert.equal(proxied, 0);
});
