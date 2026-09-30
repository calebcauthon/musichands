// Serves the app's files, and keeps workspaces.
//
// Only the app itself is served: no hidden files, no tests, nothing outside
// this folder, and only kinds of file the app uses. Workspaces live under
// DATA_DIR, each a JSON file with a folder of its own scores beside it. A new
// workspace starts with a copy of the scores listed in scores/starter.json.
// See agent.md for the API.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyHandMoves } from "./corrections.js";
import { assignFingering } from "./fingering.js";
import { parseScore } from "./score-model.js";
import { cleanState, COMMANDS, mergeState, projectScreen } from "./workspace-model.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 8 * 1024 * 1024;
const WORKSPACE_ID = /^ws-[a-z0-9]{10}$/;
const SCORE_ID = /^[0-9a-f]{64}$/;
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
// Scores are private too: a piece is only reached through a workspace that holds a copy.
const PRIVATE = new Set(["test", "node_modules", "private", "data", "scores", "server.js", "Makefile", "package.json", "package-lock.json"]);
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

function readBody(request, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const newId = () => `ws-${randomBytes(8).toString("base64url").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(10, "x").slice(0, 10)}`;
const newToken = () => randomBytes(24).toString("base64url");

// Writes a file beside its final name, then moves it in, so a reader never sees half a file.
async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

// The scores a new workspace is given: the files scores/starter.json lists, in its order.
async function readStarters(root) {
  const folder = path.join(root, "scores");
  let names;
  try {
    names = JSON.parse(await readFile(path.join(folder, "starter.json"), "utf8"));
  } catch {
    return [];
  }
  const starters = [];
  for (const name of Array.isArray(names) ? names : []) {
    const file = path.basename(String(name));
    try {
      starters.push({ file, xml: await readFile(path.join(folder, file), "utf8") });
    } catch (error) {
      console.warn(`The starter score ${file} could not be read: ${error.message}`);
    }
  }
  return starters;
}

// Workspaces on disk, with the browsers watching each one.
class Workspaces {
  constructor(dataDir, root) {
    this.dir = path.join(dataDir, "workspaces");
    this.oldScores = path.join(dataDir, "scores"); // where uploads went before workspaces held their own
    this.root = root;
    this.starters = null;
    this.watchers = new Map(); // id → Set of { response, clientId }
    this.cache = new Map();
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  scoreFile(id, scoreId) {
    return path.join(this.dir, id, "scores", `${scoreId}.musicxml`);
  }

  async get(id) {
    if (!WORKSPACE_ID.test(id)) return null;
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const record = JSON.parse(await readFile(this.file(id), "utf8"));
      if (Array.isArray(record.scores)) {
        record.state = cleanState(record.state);
        this.settle(record);
      } else await this.bringForward(record);
      this.cache.set(id, record);
      return record;
    } catch {
      return null;
    }
  }

  // A workspace from before workspaces held their own scores gets the starter
  // scores, and its own copy of the piece it had open.
  async bringForward(record) {
    const old = record.state?.score;
    record.scores = [];
    const starters = await this.seed(record);
    let open = null;
    if (old?.kind === "bundled") open = starters.find((starter) => starter.file === path.basename(String(old.url)));
    else if (old?.kind === "uploaded" && SCORE_ID.test(old.id)) {
      open = await readFile(path.join(this.oldScores, `${old.id}.musicxml`), "utf8")
        .then((xml) => this.addScore(record, xml, old.title))
        .catch(() => null);
    }
    record.state = cleanState({ ...record.state, score: open && { id: open.id } });
    this.settle(record);
    await this.write(record);
  }

  // Copies the starter scores into a workspace. Answers them with the ids they were given.
  async seed(record) {
    this.starters ??= readStarters(this.root);
    const seeded = [];
    for (const starter of await this.starters) {
      try {
        seeded.push({ ...starter, ...(await this.addScore(record, starter.xml)) });
      } catch (error) {
        console.warn(`The starter score ${starter.file} could not be used: ${error.message}`);
      }
    }
    return seeded;
  }

  // Puts a piece among a workspace's scores, under the hash of its MusicXML,
  // so the same piece twice is one score. Throws if it cannot be read as music.
  async addScore(record, xml, title = "") {
    const parsed = parseScore(xml);
    const id = createHash("sha256").update(xml, "utf8").digest("hex");
    await writeAtomic(this.scoreFile(record.id, id), xml);
    const entry = { id, title: String(title ?? "").trim().slice(0, 120) || parsed.title, measures: parsed.measures.length, added: Date.now() };
    const at = record.scores.findIndex((known) => known.id === id);
    if (at < 0) record.scores.push(entry);
    else record.scores[at] = { ...entry, added: record.scores[at].added };
    return entry;
  }

  // A workspace shows only its own scores: asked for one it does not hold, it
  // stays on the one it had, or goes to its first.
  settle(record, had = null) {
    const held = (score) => score && record.scores.find((entry) => entry.id === score.id);
    const entry = held(record.state.score) ?? held(had) ?? record.scores[0];
    record.state.score = entry ? { id: entry.id, title: entry.title } : null;
  }

  // Makes a workspace: a copy of `from`, scores and all, or a new one with the starter scores.
  async create({ name, state, from } = {}) {
    let id = newId();
    while (await this.get(id)) id = newId();
    const record = { id, name: String(name ?? "").slice(0, 80) || "Workspace", token: newToken(), version: 1, state: cleanState(state), scores: [], created: Date.now(), updated: Date.now() };
    if (from) {
      for (const entry of from.scores) {
        await mkdir(path.dirname(this.scoreFile(id, entry.id)), { recursive: true });
        await copyFile(this.scoreFile(from.id, entry.id), this.scoreFile(id, entry.id));
        record.scores.push({ ...entry });
      }
    } else await this.seed(record);
    this.settle(record);
    await this.write(record);
    return record;
  }

  // Takes a score out of a workspace. If it was the one open, the workspace
  // moves to another, and the corrections made for it go with it.
  async removeScore(record, scoreId, by = "") {
    const open = record.state.score?.id === scoreId;
    record.scores = record.scores.filter((entry) => entry.id !== scoreId);
    await unlink(this.scoreFile(record.id, scoreId)).catch(() => {});
    return this.patch(record, open ? { state: { time: 0, playing: false, corrections: { fingers: null, hands: null } } } : {}, by);
  }

  async write(record) {
    record.updated = Date.now();
    this.cache.set(record.id, record);
    await writeAtomic(this.file(record.id), JSON.stringify(record, null, 1));
  }

  // Applies a change and tells every watcher. `by` names the client that made it.
  async patch(record, { state, name } = {}, by = "", { replace = false } = {}) {
    const had = record.state.score;
    if (state) record.state = replace ? cleanState(state) : mergeState(record.state, state);
    this.settle(record, had);
    if (typeof name === "string" && name.trim()) record.name = name.trim().slice(0, 80);
    record.version += 1;
    await this.write(record);
    this.broadcast(record, by);
    return record;
  }

  async remove(record) {
    this.cache.delete(record.id);
    for (const watcher of this.watchers.get(record.id) ?? []) watcher.response.end();
    this.watchers.delete(record.id);
    await unlink(this.file(record.id)).catch(() => {});
    await rm(path.join(this.dir, record.id), { recursive: true, force: true });
  }

  watch(record, response, clientId) {
    const set = this.watchers.get(record.id) ?? this.watchers.set(record.id, new Set()).get(record.id);
    const watcher = { response, clientId, since: Date.now() };
    set.add(watcher);
    this.tellLead(record.id);
    return () => {
      set.delete(watcher);
      if (!set.size) this.watchers.delete(record.id);
      else this.tellLead(record.id);
    };
  }

  // One browser leads: it alone plays the music and runs commands. That is
  // the one that last asked to, else the longest connected.
  tellLead(id) {
    const set = this.watchers.get(id);
    if (!set) return;
    const lead = [...set].sort((a, b) => (b.claimed ?? 0) - (a.claimed ?? 0) || a.since - b.since)[0];
    for (const watcher of set) send(watcher.response, "lead", { lead: watcher === lead });
  }

  // Makes the browser watching as `clientId` the lead. Returns false if no such browser is watching.
  claimLead(record, clientId) {
    const watcher = [...(this.watchers.get(record.id) ?? [])].find((entry) => entry.clientId === clientId);
    if (!watcher) return false;
    watcher.claimed = Date.now();
    this.tellLead(record.id);
    return true;
  }

  broadcast(record, by) {
    for (const watcher of this.watchers.get(record.id) ?? []) send(watcher.response, "state", { version: record.version, state: record.state, name: record.name, scores: record.scores, by });
  }
}

function send(response, event, data) {
  try {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // The watcher has gone.
  }
}

const bearer = (request, url) => request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";

export function createAppServer(root = ROOT, { dataDir = process.env.DATA_DIR ?? path.join(root, "data"), publicUrl = process.env.PUBLIC_URL ?? "" } = {}) {
  const workspaces = new Workspaces(dataDir, root);

  // The MusicXML of the score a workspace has open.
  const scoreText = async (record) => {
    if (!record.state.score) throw new Error("no score");
    return readFile(workspaces.scoreFile(record.id, record.state.score.id), "utf8");
  };
  const sendXml = (response, xml) => {
    response.writeHead(200, { "content-type": "application/vnd.recordare.musicxml+xml; charset=utf-8", "cache-control": "no-store" });
    response.end(xml);
  };

  const api = async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    const site = publicUrl || `${request.headers["x-forwarded-proto"] ?? "http"}://${request.headers.host}`;
    const connection = (record) => ({ id: record.id, name: record.name, token: record.token, url: `${site}/#ws=${record.id}&token=${record.token}`, api: `${site}/api/workspaces/${record.id}`, manual: `${site}/agent.md`, connectionString: `MusicHands workspace "${record.name}"\nURL: ${site}\nWorkspace: ${record.id}\nToken: ${record.token}\nManual: ${site}/agent.md` });

    if (url.pathname === "/api/workspaces" && request.method === "POST") {
      let body = {};
      try {
        const text = (await readBody(request)).toString("utf8");
        body = text.trim() ? JSON.parse(text) : {};
      } catch {
        return json(400, { error: "The body must be JSON" });
      }
      let state = body.state;
      let from;
      if (body.copyFrom) {
        from = await workspaces.get(String(body.copyFrom.id ?? ""));
        if (!from || from.token !== body.copyFrom.token) return json(403, { error: "That workspace cannot be copied: wrong id or token" });
        state = { ...from.state, playing: false, command: null };
      }
      const record = await workspaces.create({ name: body.name, state, from });
      return json(201, { ...connection(record), version: record.version, state: record.state, scores: record.scores });
    }

    const match = url.pathname.match(/^\/api\/workspaces\/(ws-[a-z0-9]{10})(\/(?:events|screen|score|commands|lead|scores(?:\/[0-9a-f]{64}(?:\/summary)?)?))?$/);
    if (!match) return json(404, { error: "Not found" });
    const record = await workspaces.get(match[1]);
    if (!record) return json(404, { error: "No such workspace" });
    if (bearer(request, url) !== record.token) return json(401, { error: "The workspace token is missing or wrong" });
    const part = match[2] ?? "";
    const by = String(request.headers["x-client"] ?? url.searchParams.get("client") ?? "");

    if (part === "/events" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      send(response, "state", { version: record.version, state: record.state, name: record.name, scores: record.scores, by: "" });
      const stop = workspaces.watch(record, response, by);
      const beat = setInterval(() => response.write(": keep\n\n"), 25000).unref();
      request.on("close", () => {
        clearInterval(beat);
        stop();
      });
      return null;
    }
    if (part === "/screen" && request.method === "GET") {
      let xml;
      try {
        xml = await scoreText(record);
      } catch {
        return json(409, { error: "The workspace has no score open" });
      }
      const parsed = parseScore(xml);
      const events = applyHandMoves(parsed.events, record.state.corrections.hands);
      const fingered = assignFingering(events, { overrides: record.state.corrections.fingers });
      return json(200, { workspace: { id: record.id, name: record.name, version: record.version }, ...projectScreen(parsed, fingered.events, fingered.positions, record.state), state: record.state });
    }
    if (part === "/score" && request.method === "GET") {
      try {
        return sendXml(response, await scoreText(record));
      } catch {
        return json(409, { error: "The workspace has no score open" });
      }
    }
    const scorePart = part.match(/^\/scores(?:\/([0-9a-f]{64})(\/summary)?)?$/);
    if (scorePart && !scorePart[1]) {
      if (request.method === "GET") return json(200, { scores: record.scores });
      if (request.method === "POST") {
        let xml = (await readBody(request)).toString("utf8");
        let title = "";
        if ((request.headers["content-type"] ?? "").includes("application/json")) {
          try {
            ({ xml, title } = JSON.parse(xml));
            xml = String(xml ?? "");
          } catch {
            return json(400, { error: "The body must be JSON with an xml field, or MusicXML itself" });
          }
        }
        let entry;
        try {
          entry = await workspaces.addScore(record, xml, title);
        } catch (error) {
          return json(400, { error: `That is not MusicXML this app can read: ${error.message}` });
        }
        await workspaces.patch(record, {}, by);
        return json(201, { ...entry, version: record.version, scores: record.scores });
      }
      return json(405, { error: "Method not allowed" });
    }
    if (scorePart) {
      const [, scoreId, summary] = scorePart;
      const entry = record.scores.find((known) => known.id === scoreId);
      if (!entry) return json(404, { error: "No such score in this workspace" });
      if (request.method === "GET") {
        const xml = await readFile(workspaces.scoreFile(record.id, scoreId), "utf8");
        return summary ? json(200, { ...entry, tempo: parseScore(xml).tempo }) : sendXml(response, xml);
      }
      if (request.method === "DELETE" && !summary) {
        await workspaces.removeScore(record, scoreId, by);
        return json(200, { deleted: scoreId, version: record.version, state: record.state, scores: record.scores });
      }
      return json(405, { error: "Method not allowed" });
    }
    if (part === "/lead" && request.method === "POST") {
      // The browser where someone presses Play is the one that should play.
      if (!by) return json(400, { error: "Say which browser with x-client or ?client=" });
      if (!workspaces.claimLead(record, by)) return json(409, { error: `No browser named ${by} is watching this workspace` });
      return json(200, { lead: by });
    }
    if (part === "/commands" && request.method === "POST") {
      let body;
      try {
        body = JSON.parse((await readBody(request)).toString("utf8"));
      } catch {
        return json(400, { error: "The body must be JSON" });
      }
      if (!COMMANDS.includes(body?.type)) return json(400, { error: `The command type must be one of ${COMMANDS.join(", ")}` });
      const seq = (record.state.command?.seq ?? 0) + 1;
      await workspaces.patch(record, { state: { command: { seq, type: body.type, by } } }, by);
      return json(202, { command: record.state.command, version: record.version });
    }
    if (part === "") {
      if (request.method === "GET") return json(200, { ...connection(record), version: record.version, state: record.state, scores: record.scores, updated: record.updated });
      if (request.method === "PATCH" || request.method === "PUT") {
        let body;
        try {
          body = JSON.parse((await readBody(request)).toString("utf8"));
        } catch {
          return json(400, { error: "The body must be JSON" });
        }
        const change = body?.state !== undefined || body?.name !== undefined ? body : { state: body };
        await workspaces.patch(record, change, by, { replace: request.method === "PUT" });
        return json(200, { version: record.version, state: record.state, name: record.name, scores: record.scores });
      }
      if (request.method === "DELETE") {
        await workspaces.remove(record);
        return json(200, { deleted: record.id });
      }
    }
    return json(405, { error: "Method not allowed" });
  };

  return createServer(async (request, response) => {
    const plain = (status, text) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(text);
    };
    if ((request.url ?? "").startsWith("/api/")) {
      try {
        return await api(request, response);
      } catch (error) {
        console.error(error);
        if (!response.headersSent) return plain(500, "Something went wrong");
        return response.end();
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed");
    const file = resolveFile(request.url ?? "/", root);
    if (!file) return plain(404, "Not found");
    let info;
    try {
      info = await stat(file);
    } catch {
      return plain(404, "Not found");
    }
    if (!info.isFile()) return plain(404, "Not found");
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

// Listens on `port`, or with `--find-port` on the next free one after it.
export function serve(server, port, { findPort = false, attempts = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate) => {
      server.removeAllListeners("listening");
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" && findPort && candidate < port + attempts - 1) {
          console.log(`Port ${candidate} is in use, trying ${candidate + 1}`);
          tryPort(candidate + 1);
        } else reject(error);
      });
      server.listen(candidate, () => {
        server.removeAllListeners("error");
        resolve(server.address().port);
      });
    };
    tryPort(port);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const findPort = args.includes("--find-port");
  const port = Number(process.env.PORT ?? args.find((arg) => /^\d+$/.test(arg)) ?? 4173);
  serve(createAppServer(), port, { findPort })
    .then((chosen) => console.log(`Serving on http://localhost:${chosen}/`))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
