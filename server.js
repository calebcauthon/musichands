// Serves the app's files. Used when the app is deployed; `make dev` has its own.
//
// Only the app itself is served: no hidden files, no tests, nothing outside
// this folder, and only kinds of file the app uses.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".musicxml": "application/vnd.recordare.musicxml+xml; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".mxl": "application/vnd.recordare.musicxml",
  ".glb": "model/gltf-binary",
  ".mp3": "audio/mpeg",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const PRIVATE = new Set(["test", "node_modules", "private", "server.js", "serve.py", "Makefile", "package.json", "package-lock.json"]);
// Sounds and the hand model never change; pages and scripts should stay fresh.
const LONG_LIVED = new Set([".mp3", ".glb"]);

// The file a request path names, or null if it is not one the app serves.
export function resolveFile(requestPath, root = ROOT) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split("?")[0]);
  } catch {
    return null;
  }
  // Refuse anything that tries to climb, before the path is tidied.
  if (decoded.includes("\0") || decoded.split(/[\\/]/).includes("..")) return null;
  const relative = path.posix.normalize(decoded).replace(/^\/+/, "") || "index.html";
  const parts = relative.split("/");
  if (parts.some((part) => part.startsWith(".")) || PRIVATE.has(parts[0])) return null;
  const file = path.join(root, ...parts);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return TYPES[path.extname(file).toLowerCase()] ? file : null;
}

export function createAppServer(root = ROOT) {
  return createServer(async (request, response) => {
    const send = (status, text) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(text);
    };
    if (request.method !== "GET" && request.method !== "HEAD") return send(405, "Method not allowed");
    const file = resolveFile(request.url ?? "/", root);
    if (!file) return send(404, "Not found");
    let info;
    try {
      info = await stat(file);
    } catch {
      return send(404, "Not found");
    }
    if (!info.isFile()) return send(404, "Not found");
    const extension = path.extname(file).toLowerCase();
    response.writeHead(200, {
      "content-type": TYPES[extension],
      "content-length": info.size,
      "cache-control": LONG_LIVED.has(extension) ? "public, max-age=604800" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(file).on("error", () => response.destroy()).pipe(response);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 4173);
  createAppServer().listen(port, () => console.log(`Serving on port ${port}`));
}
