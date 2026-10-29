#!/usr/bin/env node
import { createServer } from "node:http";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { startRuntimeIdentity } from "../server/runtime-identity.mjs";
const stopIdentity = startRuntimeIdentity();
if (existsSync(resolve(".env"))) loadEnvFile(resolve(".env"));
const port = Number(process.env.PORT || 4182),
  host = process.env.HOST || "127.0.0.1";
if (process.argv.includes("--healthcheck")) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    process.exit(r.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
// Health probes exit above without loading the database, SDKs or application.
const [
  { Store },
  { AliyunGateway },
  { ResourceService },
  { Jobs },
  { Engine },
  { Notifications },
  { createApp },
] = await Promise.all([
  import("../server/store.mjs"),
  import("../server/aliyun.mjs"),
  import("../server/service.mjs"),
  import("../server/jobs.mjs"),
  import("../server/engine.mjs"),
  import("../server/notify.mjs"),
  import("../server/app.mjs"),
]);
const store = new Store(resolve(process.env.DATA_DIR || "data")),
  gateway = new AliyunGateway(store),
  service = new ResourceService(store, gateway),
  notify = new Notifications(store),
  jobs = new Jobs(store, gateway, service, notify),
  engine = new Engine(store, gateway, service, jobs, notify);
const app = createApp({ store, gateway, service, jobs, notify, engine }),
  server = createServer(app);
server.listen(port, host, () => {
  console.log(`Aliyun Panel http://${host}:${port}`);
  engine.start();
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  engine.stop();
  stopIdentity();
  server.close();
  const timer = setInterval(() => {
    if (
      !jobs.running.size &&
      !engine.policyRunning &&
      !engine.reportRunning &&
      !service.refreshing &&
      !service.capturing &&
      !service.history.running.size &&
      !notify.running &&
      !engine.billing.running.size
    ) {
      clearInterval(timer);
      store.close();
      process.exit(0);
    }
  }, 100);
  setTimeout(() => process.exit(0), 20000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
