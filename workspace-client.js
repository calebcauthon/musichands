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

const REMEMBERED = "musichands-workspaces"; // the workspaces this browser has opened, newest first
const CLIENT = "musichands-client";

const api = (base, path, token, options = {}) =>
  fetch(`${base}/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) },
  });

async function answer(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
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

export function rememberedWorkspaces() {
  try {
    const list = JSON.parse(localStorage.getItem(REMEMBERED) ?? "[]");
    return Array.isArray(list) ? list.filter((entry) => entry && entry.id && entry.token) : [];
  } catch {
    return [];
  }
}

export function rememberWorkspace(entry) {
  const list = [{ id: entry.id, token: entry.token, name: entry.name }, ...rememberedWorkspaces().filter((known) => known.id !== entry.id)].slice(0, 30);
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(list));
  } catch {
    // Nothing to do: the address bar still has it.
  }
  return list;
}

export function forgetWorkspace(id) {
  const list = rememberedWorkspaces().filter((known) => known.id !== id);
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(list));
  } catch {
    // As above.
  }
  return list;
}

export class WorkspaceClient extends EventTarget {
  constructor({ base = "", id, token, client = clientName() }) {
    super();
    this.base = base;
    this.id = id;
    this.token = token;
    this.client = client;
    this.state = null;
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

  take({ version, state, name, by }) {
    if (version < this.version) return;
    this.version = version;
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

  // Sends a piece to the server; answers { id, title, measures }.
  uploadScore(xml) {
    return api(this.base, "/scores", null, { method: "POST", body: JSON.stringify({ xml }) }).then(answer);
  }

  static create(base, body = {}) {
    return api(base, "/workspaces", null, { method: "POST", body: JSON.stringify(body) }).then(answer);
  }
}
