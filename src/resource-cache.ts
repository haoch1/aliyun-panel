/** Session-only response cache: no credentials or data are persisted in the browser. */
export function createResourceCache(limit = 80) {
  let version = 0;
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (key: string) => listeners.get(key)?.forEach((fn) => fn());
  const requests = new Map<
    string,
    { promise: Promise<unknown>; revision: number }
  >();
  return {
    get version() {
      return version;
    },
    get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    subscribe(key: string, listener: () => void) {
      const group = listeners.get(key) || new Set<() => void>();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(key);
      };
    },
    clear() {
      version++;
      values.clear();
      requests.clear();
      listeners.forEach((_, key) => notify(key));
    },
    request<T>(key: string, load: () => Promise<T>, revision = 0): Promise<T> {
      const running = requests.get(key);
      if (running?.revision === revision) return running.promise as Promise<T>;
      const started = version;
      const request = Promise.resolve()
        .then(load)
        .then((data) => {
          if (started === version && requests.get(key)?.promise === request) {
            values.delete(key);
            values.set(key, data);
            if (values.size > limit) {
              const oldest = values.keys().next().value!;
              values.delete(oldest);
              notify(oldest);
            }
            notify(key);
          }
          return data;
        })
        .finally(() => {
          if (requests.get(key)?.promise === request) requests.delete(key);
        });
      requests.set(key, { promise: request, revision });
      return request;
    },
  };
}
