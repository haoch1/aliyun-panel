/** Session-only response cache: no credentials or data are persisted in the browser. */
export function createResourceCache(limit = 80) {
  let version = 0;
  const values = new Map<string, unknown>();
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
    clear() {
      version++;
      values.clear();
      requests.clear();
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
            if (values.size > limit) values.delete(values.keys().next().value!);
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
