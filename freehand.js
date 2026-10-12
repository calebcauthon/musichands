// Sheet music of the agent's own: a passage it writes itself, not in the
// piece. Each hand gets its notes in order — the keys struck with their
// fingers, how many beats each lasts, and when one does not follow straight
// on, the beat it begins on — and, if the agent wants the hand to hold still,
// a POSITION: where every finger rests, pressed or not. What comes out is a
// sheet as the workspace keeps it (workspace-model.js: sheets): the passage
// as MusicXML, which the page draws and plays like any score, and the
// resting fingers at each moment, which the fingering (fingering.js) lays
// under the hand so that it sits where the agent said.
import { noteToMidi } from "./hand-model.js";
import { FINGER_SHORT, momentName } from "./lesson.js";
import { parseScore } from "./score-model.js";
import { writeScore } from "./score-writer.js";

export const MOST_NOTES = 64; // notes one hand may play in a sheet
const HANDS = ["right", "left"];
const NOTE = /^[A-G][#b]?-?\d$/;
const LEAST_BEATS = 0.25;
const MOST_BEATS = 8;
const REACH = 14; // semitones a hand stretches, thumb to pinky
const FINGER = /^[1-5]$/;
const METERS = [2, 3, 4, 6];

const fingerName = (finger) => FINGER_SHORT[finger] ?? `finger ${finger}`;
const onKey = (entry) => `${fingerName(entry.finger)} on ${entry.note}`;
const beatName = (time) => String(Math.round((time + 1) * 100) / 100);

// Fingers on keys as given, or why they are not: each a finger (1 to 5) on a
// note (C4, F#3, Bb2), no finger on two keys, no key under two fingers.
function readFingers(list, what) {
  if (!Array.isArray(list)) return { error: `${what} must be a list of fingers on keys` };
  const fingers = [];
  for (const entry of list) {
    const finger = Number(entry?.finger);
    const note = String(entry?.note ?? "");
    if (!FINGER.test(String(entry?.finger)) || !NOTE.test(note)) return { error: `${what}: finger ${entry?.finger ?? "?"} on ${note || "nothing"} is not a finger on a key (fingers 1 to 5, notes like C4, F#3, Bb2)` };
    if (fingers.some((known) => known.finger === finger)) return { error: `${what}: the ${fingerName(finger)} is on two keys` };
    if (fingers.some((known) => known.note === note)) return { error: `${what}: two fingers on ${note}` };
    fingers.push({ finger, note, midi: noteToMidi(note) });
  }
  return { fingers };
}

// Why a hand cannot sit like that, or null: fingers must follow the keys —
// up the keyboard for the right hand, down for the left — within a stretch.
function awkward(fingers, hand) {
  const sign = hand === "left" ? -1 : 1;
  const ordered = [...fingers].sort((a, b) => sign * (a.midi - b.midi));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].finger <= ordered[index - 1].finger) return `${onKey(ordered[index])} with ${onKey(ordered[index - 1])} puts the fingers out of order for the ${hand} hand`;
  }
  const midis = fingers.map((entry) => entry.midi);
  if (Math.max(...midis) - Math.min(...midis) > REACH) return `${onKey(ordered[0])} to ${onKey(ordered.at(-1))} is more than a hand can stretch`;
  return null;
}

// The hand's notes as a timeline of events, each with the position in force
// from it on, or why they are not.
function readHand(hand, given) {
  const where = (index) => `${hand} hand, note ${index + 1}`;
  const start = readFingers(given.position ?? [], `${hand} hand, position`);
  if (start.error) return start;
  let position = start.fingers;
  let trouble = awkward(position, hand);
  if (trouble) return { error: `${hand} hand, position: ${trouble}` };
  const notes = Array.isArray(given.notes) ? given.notes : [];
  if (!notes.length) return { error: `the ${hand} hand has no notes` };
  if (notes.length > MOST_NOTES) return { error: `the ${hand} hand has ${notes.length} notes; ${MOST_NOTES} at most in one sheet` };
  const events = [];
  let cursor = 0; // beats from the start, where the next note begins unless it says
  for (const [index, note] of notes.entries()) {
    const keys = readFingers(note?.keys, where(index));
    if (keys.error) return keys;
    if (!keys.fingers.length) return { error: `${where(index)}: no keys` };
    trouble = awkward(keys.fingers, hand);
    if (trouble) return { error: `${where(index)}: ${trouble}` };
    if (note.position !== undefined) {
      const fresh = readFingers(note.position, `${where(index)}, position`);
      if (fresh.error) return fresh;
      trouble = awkward(fresh.fingers, hand);
      if (trouble) return { error: `${where(index)}, position: ${trouble}` };
      position = fresh.fingers;
    }
    const at = note.at === undefined || note.at === null ? cursor : Number(note.at) - 1;
    if (!(at >= 0)) return { error: `${where(index)}: "at" is the beat it begins on, counted from one` };
    const beats = Math.min(MOST_BEATS, Math.max(LEAST_BEATS, Number(note.beats) || 1));
    events.push({ hand, time: at, duration: beats, notes: keys.fingers, position });
    cursor = at + beats;
  }
  // In time order; a note lasts until the next one of the hand begins, at most.
  events.sort((a, b) => a.time - b.time);
  for (let index = 0; index + 1 < events.length; index += 1) {
    const event = events[index];
    const next = events[index + 1];
    if (next.time - event.time < 1e-6) return { error: `${hand} hand: two things begin on beat ${beatName(event.time)}; make them one chord` };
    event.duration = Math.min(event.duration, next.time - event.time);
  }
  return { events };
}

// Where the hand's fingers rest at a moment of the written sheet: the
// position in force there, less any finger or key the moment plays. The
// whole hand — played and resting — must be one a hand can hold.
function restsAt(event, written, hand) {
  const position = written.filter((entry) => entry.time <= event.time + 1e-6).at(-1)?.position ?? [];
  const played = event.notes.map((note) => ({ finger: note.finger, note: note.note, midi: note.midi }));
  const keys = new Set(played.map((entry) => entry.midi));
  const fingers = new Set(played.map((entry) => entry.finger));
  const resting = position.filter((entry) => !keys.has(entry.midi) && !fingers.has(entry.finger));
  const trouble = awkward([...played, ...resting], hand);
  if (trouble) return { error: `${hand} hand, ${momentName(event)}: ${trouble}; give the hand a new position from that note` };
  return { resting: resting.map(({ finger, note }) => ({ finger, note })) };
}

// The sheet as the workspace keeps it — { title, xml, rests, measures } —
// or { error }. args: title, tempo, beats_per_measure, and right/left as
// { position, notes: [{ keys, beats, at, position }] }.
export function writeSheet(args = {}) {
  const title = String(args.title ?? "").trim().slice(0, 80);
  if (!title) return { error: "Give the sheet a title" };
  const tempo = args.tempo === undefined || args.tempo === null ? null : Math.min(240, Math.max(30, Math.round(Number(args.tempo) || 0))) || null;
  const meter = Number(args.beats_per_measure ?? 4);
  if (!METERS.includes(meter)) return { error: `beats_per_measure must be one of ${METERS.join(", ")}` };
  const written = {};
  for (const hand of HANDS) {
    if (args[hand] === undefined || args[hand] === null) continue;
    if (typeof args[hand] !== "object") return { error: `${hand} must be { position, notes }` };
    const read = readHand(hand, args[hand]);
    if (read.error) return read;
    written[hand] = read.events;
  }
  if (!Object.keys(written).length) return { error: "No notes to write: give right and/or left their notes" };

  const parts = Object.fromEntries(Object.entries(written).map(([hand, events]) => [hand, events.map((event) => ({ time: event.time, duration: event.duration, notes: event.notes.map(({ note, finger }) => ({ note, finger })) }))]));
  const xml = writeScore({ title, tempo, beatsPerMeasure: meter, parts });
  // Read back as the page will read it, so the rests go by its moments.
  const parsed = parseScore(xml);
  const rests = {};
  for (const event of parsed.events) {
    const result = restsAt(event, written[event.hand] ?? [], event.hand);
    if (result.error) return result;
    if (!result.resting.length) continue;
    rests[momentName(event)] ??= {};
    rests[momentName(event)][event.hand] = result.resting;
  }
  return { title, xml, rests, measures: parsed.measures.length };
}
