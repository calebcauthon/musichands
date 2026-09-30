// The page's side of a workspace: opens it, keeps a live copy in step with the
// server over server-sent events, and sends changes back. Everything the page
// shows comes from `state`; nothing is kept anywhere else.
import { mergeState } from "./workspace-model.js";

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
// Lays one patch over another without losing the nulls that mean "take away".
function layer(into, from) {
  if (!isObject(from) || !isObject(into)) return from;
  const out = { ...into };
  for (const [key, value] of Object.entries(from)) out[key] = isObject(value) && isObject(out[key]) ? layer(out[key], value) : value;
  return out;
}

const HOME = "musichands-workspace"; // this browser's own workspace: { id, token }
const REMEMBERED = "musichands-workspaces"; // the list kept when a browser could hold several, newest first
const CLIENT = "musichands-client";

const api = (base, path, token, options = {}) =>
  fetch(`${base}/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) },
  });

async function answer(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? `${response.status} ${response.statusText}`), { status: response.status });
  return body;
}

// A name for this browser tab, so changes can be told apart from an agent's.
export function clientName() {
  let name = null;
  try {
    name = sessionStorage.getItem(CLIENT);
    if (!name) {
      name = `browser-${Math.random().toString(36).slice(2, 6)}`;
      sessionStorage.setItem(CLIENT, name);
    }
  } catch {
    name ??= "browser";
  }
  return name;
}

// Reads `#ws=<id>&token=<token>` off the page address.
export function workspaceFromHash(hash = location.hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const id = params.get("ws");
  const token = params.get("token");
  return id && token ? { id, token } : null;
}

// Pulls the id and token out of a connection string, a workspace URL, or a bare "id token".
export function parseConnection(text) {
  const source = String(text ?? "");
  const id = source.match(/\bws-[a-z0-9]{10}\b/)?.[0];
  const token = source.match(/(?:Token:\s*|[&#?]token=)([A-Za-z0-9_-]{20,})/)?.[1] ?? source.match(/\b([A-Za-z0-9_-]{32})\b/)?.[1];
  return id && token ? { id, token } : null;
}

// The workspace this browser calls its own, or null if it has none yet.
export function homeWorkspace() {
  try {
    const home = JSON.parse(localStorage.getItem(HOME) ?? "null") ?? JSON.parse(localStorage.getItem(REMEMBERED) ?? "[]")[0];
    return home?.id && home?.token ? { id: home.id, token: home.token } : null;
  } catch {
    return null;
  }
}

export function keepHomeWorkspace(entry) {
  try {
    if (entry) localStorage.setItem(HOME, JSON.stringify({ id: entry.id, token: entry.token }));
    else {
      localStorage.removeItem(HOME);
      localStorage.removeItem(REMEMBERED);
    }
  } catch {
    // The workspace lasts only for this visit.
  }
}

export class WorkspaceClient extends EventTarget {
  constructor({ base = "", id, token, client = clientName() }) {
    super();
    this.base = base;
    this.id = id;
    this.token = token;
    this.client = client;
    this.state = null;
    this.scores = []; // the workspace's own scores: [{ id, title, measures, added }]
    this.name = "";
    this.version = 0;
    this.lead = false;
    this.connected = false;
    this.source = null;
    this.pending = null; // a patch waiting to be sent
    this.sending = null; // the request on its way
    this.info = null;
  }

  get path() {
    return `/workspaces/${this.id}`;
  }

  // Loads the workspace and starts listening. Throws if it cannot be opened.
  async open() {
    this.info = await answer(await api(this.base, this.path, this.token));
    this.take(this.info);
    this.listen();
    return this.info;
  }

  take({ version, state, name, scores, by }) {
    if (version < this.version) return;
    this.version = version;
    if (Array.isArray(scores)) this.scores = scores;
    // A change of ours still on its way stays on top of what the server sent.
    this.state = this.pending ? mergeState(state, this.pending) : state;
    if (typeof name === "string") this.name = name;
    this.dispatchEvent(new CustomEvent("state", { detail: { state, version, by: by ?? "" } }));
  }

  listen() {
    this.close();
    const url = `${this.base}/api${this.path}/events?token=${encodeURIComponent(this.token)}&client=${encodeURIComponent(this.client)}`;
    const source = new EventSource(url);
    this.source = source;
    source.addEventListener("state", (event) => {
      this.setConnected(true);
      this.take(JSON.parse(event.data));
    });
    source.addEventListener("lead", (event) => {
      const { lead } = JSON.parse(event.data);
      if (lead === this.lead) return;
      this.lead = lead;
      this.dispatchEvent(new CustomEvent("lead", { detail: { lead } }));
    });
    source.onerror = () => this.setConnected(false); // EventSource reconnects on its own
  }

  setConnected(connected) {
    if (connected === this.connected) return;
    this.connected = connected;
    this.dispatchEvent(new CustomEvent("connection", { detail: { connected } }));
  }

  close() {
    this.source?.close();
    this.source = null;
    this.setConnected(false);
  }

  // Lays a change over the local state at once (so the page feels quick) and
  // sends it on. Changes made in quick succession travel together.
  change(patch) {
    if (!this.state) return;
    this.state = mergeState(this.state, patch);
    this.dispatchEvent(new CustomEvent("state", { detail: { state: this.state, version: this.version, by: this.client, local: true } }));
    this.pending = this.pending ? layer(this.pending, patch) : patch;
    this.flush();
  }

  flush() {
    if (this.sending || !this.pending) return;
    const patch = this.pending;
    this.pending = null;
    this.sending = api(this.base, this.path, this.token, { method: "PATCH", headers: { "x-client": this.client }, body: JSON.stringify(patch) })
      .then(answer)
      .then((body) => {
        if (body.version > this.version) this.version = body.version;
      })
      .catch((error) => this.dispatchEvent(new CustomEvent("error", { detail: { error } })))
      .finally(() => {
        this.sending = null;
        this.flush();
      });
  }

  async rename(name) {
    const body = await answer(await api(this.base, this.path, this.token, { method: "PATCH", headers: { "x-client": this.client }, body: JSON.stringify({ name }) }));
    this.name = body.name;
    if (this.info) this.info.name = body.name;
    this.dispatchEvent(new CustomEvent("state", { detail: { state: this.state, version: this.version, by: this.client, local: true } }));
    return body.name;
  }

  command(type) {
    return api(this.base, `${this.path}/commands`, this.token, { method: "POST", headers: { "x-client": this.client }, body: JSON.stringify({ type }) }).then(answer);
  }

  // The connection details, fresh from the server so the URL matches the site.
  async details() {
    this.info = await answer(await api(this.base, this.path, this.token));
    return this.info;
  }

  remove() {
    return api(this.base, this.path, this.token, { method: "DELETE" }).then(answer);
  }

  // The MusicXML of one of the workspace's scores.
  async readScore(id) {
    const response = await api(this.base, `${this.path}/scores/${id}`, this.token);
    if (!response.ok) throw new Error(response.status === 404 ? "it is not in this workspace" : `the server answered ${response.status}`);
    return response.text();
  }

  // Adds a piece to the workspace's scores; answers { id, title, measures }.
  async addScore(xml, title) {
    const body = await answer(await api(this.base, `${this.path}/scores`, this.token, { method: "POST", headers: { "x-client": this.client }, body: JSON.stringify({ xml, title }) }));
    this.scores = body.scores;
    return body;
  }

  // Asks to be the browser that plays the music. The answer comes as a "lead" event.
  claimLead() {
    return api(this.base, `${this.path}/lead`, this.token, { method: "POST", headers: { "x-client": this.client } }).then(answer);
  }

  // Takes a score out of the workspace for good. The server moves on to another if it was open.
  removeScore(id) {
    return api(this.base, `${this.path}/scores/${id}`, this.token, { method: "DELETE", headers: { "x-client": this.client } }).then(answer);
  }

  static create(base, body = {}) {
    return api(base, "/workspaces", null, { method: "POST", body: JSON.stringify(body) }).then(answer);
  }
}
