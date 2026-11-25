import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function compressedAssets(directory) {
  const compressed = new Set(
    existsSync(directory) ? readdirSync(directory) : [],
  );
  return (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) return next();
    const file = req.path.slice(1);
    if (!/^[\w.-]+\.(?:css|js)$/.test(file) || !compressed.has(file + ".gz"))
      return next();
    res.vary("Accept-Encoding");
    if (req.acceptsEncodings("gzip", "identity") !== "gzip") return next();
    res.type(file.endsWith(".css") ? "css" : "js");
    res.set("Content-Encoding", "gzip");
    res.sendFile(resolve(directory, file + ".gz"), {
      maxAge: "1y",
      immutable: true,
      acceptRanges: false,
    });
  };
}
