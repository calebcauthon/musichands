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

// Moves notes to the other hand: `moves` is { "measure:beat": { note: hand } }.
// Returns new events, in time order, with a hand's event created or dropped
// as notes come and go.
export function applyHandMoves(events, moves) {
  if (!moves || !Object.keys(moves).length) return events;
  const out = events.map((event) => ({ ...event, notes: [...event.notes] }));
  const find = (hand, time) => out.find((event) => event.hand === hand && Math.abs(event.time - time) < 1e-6);
  for (const event of [...out]) {
    const wanted = moves[momentKey(event)];
    if (!wanted) continue;
    for (const note of [...event.notes]) {
      const hand = wanted[note.note];
      if (!hand || hand === event.hand) continue;
      event.notes = event.notes.filter((entry) => entry !== note);
      let target = find(hand, event.time);
      if (!target) {
        target = { ...event, hand, notes: [], duration: 0, attack: false };
        out.push(target);
      }
      if (!target.notes.some((entry) => entry.midi === note.midi)) target.notes.push(note);
      target.duration = Math.max(target.duration, note.duration ?? event.duration);
      if (!note.held) target.attack = true;
    }
  }
  return out
    .filter((event) => event.notes.length)
    .map((event) => ({ ...event, attack: event.notes.some((note) => !note.held), notes: [...event.notes].sort((a, b) => a.midi - b.midi) }))
    .sort((a, b) => a.time - b.time || (a.hand === "right" ? -1 : 1));
}

export function countCorrections(overrides) {
  let count = 0;
  for (const [key, hands] of Object.entries(overrides ?? {})) {
    if (key.startsWith("_")) continue;
    for (const notes of Object.values(hands)) count += Object.keys(notes).length;
  }
  return count;
}
