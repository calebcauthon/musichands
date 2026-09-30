// Serves the app's files, and keeps the player's fingering corrections.
//
// Only the app itself is served: no hidden files, no tests, nothing outside
// this folder, and only kinds of file the app uses. Corrections live under
// DATA_DIR as one JSON file per score. Set EDIT_KEY to require a key for
// saving them; without it anyone who can reach the server can save.
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FINGERING_PATH = /^\/api\/fingerings\/([0-9a-f]{64})$/;
const MAX_BODY = 1024 * 1024;
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
const PRIVATE = new Set(["test", "node_modules", "private", "data", "server.js", "serve.py", "Makefile", "package.json", "package-lock.json"]);
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

// Validates a corrections map: { "measure:beat": { hand: { note: finger } } },
// with anything else left out.
export function cleanOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clean = {};
  for (const [moment, hands] of Object.entries(value)) {
    if (!/^[^:\s]{1,12}:[0-9.]{1,12}$/.test(moment) || !hands || typeof hands !== "object") continue;
    for (const hand of ["left", "right"]) {
      const notes = hands[hand];
      if (!notes || typeof notes !== "object") continue;
      for (const [note, finger] of Object.entries(notes)) {
        if (!/^[A-G][#b]?-?\d$/.test(note) || ![1, 2, 3, 4, 5].includes(Number(finger))) continue;
        clean[moment] ??= {};
        clean[moment][hand] ??= {};
        clean[moment][hand][note] = Number(finger);
      }
    }
  }
  return clean;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function createAppServer(root = ROOT, { dataDir = process.env.DATA_DIR ?? path.join(root, "data"), editKey = process.env.EDIT_KEY ?? "" } = {}) {
  const fingeringFile = (id) => path.join(dataDir, "fingerings", `${id}.json`);

  const api = async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    const match = request.url.split("?")[0].match(FINGERING_PATH);
    if (!match) return json(404, { error: "Not found" });
    const file = fingeringFile(match[1]);
    if (request.method === "GET") {
      try {
        return json(200, JSON.parse(await readFile(file, "utf8")));
      } catch {
        return json(404, { error: "No corrections yet" });
      }
    }
    if (request.method !== "PUT") return json(405, { error: "Method not allowed" });
    if (editKey && request.headers["x-edit-key"] !== editKey) return json(401, { error: "An editing key is needed to save" });
    let overrides;
    try {
      overrides = cleanOverrides(JSON.parse(await readBody(request)));
    } catch {
      return json(400, { error: "Bad request" });
    }
    if (!overrides) return json(400, { error: "Corrections must be an object" });
    await mkdir(path.dirname(file), { recursive: true });
    // Write beside, then move in, so a reader never sees half a file.
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(overrides, null, 1));
    await rename(temporary, file);
    return json(200, overrides);
  };

  return createServer(async (request, response) => {
    const send = (status, text) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(text);
    };
    if ((request.url ?? "").startsWith("/api/")) {
      try {
        return await api(request, response);
      } catch (error) {
        console.error(error);
        return send(500, "Something went wrong");
      }
    }
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
