import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = "dist/assets";
const compress = promisify(gzip);
await Promise.all(
  (await readdir(directory))
    .filter((name) => /\.(?:css|js)$/.test(name))
    .map(async (name) => {
      const path = join(directory, name);
      const source = await readFile(path);
      if (source.length < 1024) return;
      const result = await compress(source, { level: 9 });
      if (result.length < source.length) await writeFile(path + ".gz", result);
    }),
);
