// The player's fingering corrections: which finger plays which note at a
// moment, stored by the score's content so they follow the score wherever it
// is opened. The server keeps them; see server.js.

const HEX = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// A score's identity: the same MusicXML anywhere gives the same id.
export async function scoreId(xml) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(xml));
  return HEX(digest);
}

export const momentKey = (event) => `${event.measure}:${event.beat}`;

const sameNotes = (a, b) => a.length === b.length && a.every((note, index) => note.midi === b[index].midi);

// The events a correction at `event` should also apply to: the same hand
// playing exactly the same notes, anywhere in the piece.
export function matchingMoments(events, event) {
  return events.filter((other) => other.hand === event.hand && sameNotes(other.notes, event.notes));
}

// Returns a new overrides map with `finger` set for `note` at each moment.
// A finger of null takes the correction away again.
export function withCorrection(overrides, moments, hand, note, finger) {
  const next = structuredClone(overrides ?? {});
  for (const moment of moments) {
    const key = momentKey(moment);
    next[key] ??= {};
    next[key][hand] ??= {};
    if (finger) next[key][hand][note] = finger;
    else delete next[key][hand][note];
    if (!Object.keys(next[key][hand]).length) delete next[key][hand];
    if (!Object.keys(next[key]).length) delete next[key];
  }
  return next;
}

export function countCorrections(overrides) {
  let count = 0;
  for (const [key, hands] of Object.entries(overrides ?? {})) {
    if (key.startsWith("_")) continue;
    for (const notes of Object.values(hands)) count += Object.keys(notes).length;
  }
  return count;
}

// Talks to the server. `askForKey` is called when the server wants an editing
// key and returns one, or null to give up.
export class CorrectionStore {
  constructor({ base = "", askForKey = async () => null } = {}) {
    this.base = base;
    this.askForKey = askForKey;
    this.available = null; // null until the first answer from the server
  }

  get key() {
    return localStorage.getItem("musichands-edit-key") ?? "";
  }

  set key(value) {
    if (value) localStorage.setItem("musichands-edit-key", value);
    else localStorage.removeItem("musichands-edit-key");
  }

  async load(id) {
    try {
      const response = await fetch(`${this.base}/api/fingerings/${id}`, { cache: "no-store" });
      this.available = response.ok || response.status === 404;
      if (!response.ok) return {};
      return await response.json();
    } catch {
      this.available = false;
      return {};
    }
  }

  // Saves the whole map. Returns true when the server has it. If the server
  // wants a key, the player is asked, and asked again after a wrong one.
  async save(id, overrides) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response;
      try {
        response = await fetch(`${this.base}/api/fingerings/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-edit-key": this.key },
          body: JSON.stringify(overrides),
        });
      } catch {
        return false;
      }
      if (response.ok) return true;
      if (response.status !== 401 && response.status !== 403) return false;
      // The server wants a key: ask once, then try again with it.
      const key = await this.askForKey(attempt > 0 || this.key !== "");
      if (!key) return false;
      this.key = key;
    }
    return false;
  }
}
