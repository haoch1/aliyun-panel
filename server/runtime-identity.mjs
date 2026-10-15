import { readFileSync, readdirSync, writeFileSync } from "node:fs";

export const RUNTIME_NAME = "aliyun-panel";

export function startRuntimeIdentity({ intervalMs = 30_000 } = {}) {
  process.title = RUNTIME_NAME;
  if (process.platform !== "linux") return () => {};

  let warned = false;
  function syncThreads() {
    try {
      for (const tid of readdirSync("/proc/self/task")) {
        const path = `/proc/self/task/${tid}/comm`;
        try {
          if (readFileSync(path, "utf8").trim() !== RUNTIME_NAME)
            writeFileSync(path, RUNTIME_NAME);
        } catch (error) {
          // Threads can exit between discovery and the write.
          if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
        }
      }
    } catch (error) {
      if (!warned) {
        console.warn(
          `${RUNTIME_NAME}: thread naming unavailable (${error.code})`,
        );
        warned = true;
      }
    }
  }

  syncThreads();
  const startup = setTimeout(syncThreads, 1000).unref();
  const timer = setInterval(syncThreads, intervalMs).unref();
  return () => {
    clearTimeout(startup);
    clearInterval(timer);
  };
}
