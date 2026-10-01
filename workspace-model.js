// A workspace: everything the sheet page shows, as data. The page projects a
// workspace; an agent changes the same data through the API; the server
// keeps them in step. Nothing on the screen lives anywhere else.
import { cleanView } from "./camera-orbit.js";
import { readShots } from "./camera-shots.js";
import { cleanLesson } from "./lesson.js";
import { cleanLook, defaultLook } from "./looks.js";

export const COMMANDS = ["play", "stop", "replay-together", "replay-succession", "replay-roundtrip"];
export const LIMITS = { tempo: [30, 240], reflexes: [0.5, 4] };

export function defaultState() {
  return {
    score: null, // { id, title }: one of the workspace's own scores; the server opens the first
    time: 0, // quarter notes from the start of the piece: the moment on screen
    tempo: null, // quarter notes a minute; null means the score's own
    reflexes: 1, // how many times faster than usual the hands move
    playing: false,
    camera: { view: { azimuth: 0, elevation: 72, zoom: 1 }, shots: null, autoCut: false }, // shots null = the ready-made ones
    hands: { left: { show: true, sound: true }, right: { show: true, sound: true } },
    numbers: true, // finger numbers over the keys
    sound: true,
    look: defaultLook(), // the piano, the player and the place, by name (see looks.js)
    corrections: { fingers: {}, hands: {} },
    lesson: null, // { from, to, stage, phase }: the passage being learnt (see lesson.js), or none
    pose: { left: null, right: null }, // a hand put where it is told, not where the score has it: { fingers: [{ finger, note }], press: [note] }
    command: null, // { seq, type }: the last thing an agent asked the page to do
  };
}

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const MOMENT = /^[^:\s]{1,12}:[0-9.]{1,12}$/;
const NOTE = /^[A-G][#b]?-?\d$/;

// A map of corrections: { "measure:beat": { hand: { note: finger } } }.
export function cleanFingers(value) {
  if (!isObject(value)) return {};
  const clean = {};
  for (const [moment, hands] of Object.entries(value)) {
    if (!MOMENT.test(moment) || !isObject(hands)) continue;
    for (const hand of ["left", "right"]) {
      if (!isObject(hands[hand])) continue;
      for (const [note, finger] of Object.entries(hands[hand])) {
        if (!NOTE.test(note) || ![1, 2, 3, 4, 5].includes(Number(finger))) continue;
        clean[moment] ??= {};
        clean[moment][hand] ??= {};
        clean[moment][hand][note] = Number(finger);
      }
    }
  }
  return clean;
}

// Notes moved to the other hand: { "measure:beat": { note: "left" | "right" } }.
export function cleanHandMoves(value) {
  if (!isObject(value)) return {};
  const clean = {};
  for (const [moment, notes] of Object.entries(value)) {
    if (!MOMENT.test(moment) || !isObject(notes)) continue;
    for (const [note, hand] of Object.entries(notes)) {
      if (!NOTE.test(note) || !["left", "right"].includes(hand)) continue;
      clean[moment] ??= {};
      clean[moment][note] = hand;
    }
  }
  return clean;
}

// A hand position given directly: which finger on which note, and which of
// those keys are pressed. Null for a hand left to the score.
export function cleanPose(value) {
  if (!isObject(value) || !Array.isArray(value.fingers)) return null;
  const fingers = [];
  for (const entry of value.fingers) {
    const finger = Number(entry?.finger);
    if (![1, 2, 3, 4, 5].includes(finger) || !NOTE.test(String(entry?.note)) || fingers.some((known) => known.finger === finger)) continue;
    fingers.push({ finger, note: String(entry.note) });
  }
  if (!fingers.length) return null;
  fingers.sort((a, b) => a.finger - b.finger);
  const press = Array.isArray(value.press) ? [...new Set(value.press.map(String).filter((note) => NOTE.test(note)))] : [];
  return { fingers, press };
}

// Whatever was stored or sent, made into a state the page can show.
export function cleanState(value) {
  const base = defaultState();
  if (!isObject(value)) return base;
  const state = base;
  if (isObject(value.score)) {
    const { id, title } = value.score;
    if (typeof id === "string" && /^[0-9a-f]{64}$/.test(id)) state.score = { id, title: String(title ?? "") };
  }
  if (Number.isFinite(value.time)) state.time = Math.max(0, value.time);
  if (value.tempo === null) state.tempo = null;
  else if (Number.isFinite(value.tempo)) state.tempo = Math.round(clamp(value.tempo, LIMITS.tempo));
  if (Number.isFinite(value.reflexes)) state.reflexes = clamp(value.reflexes, LIMITS.reflexes);
  state.playing = Boolean(value.playing);
  if (isObject(value.camera)) {
    const view = cleanView(value.camera.view);
    if (view) state.camera.view = view;
    if (value.camera.shots === null) state.camera.shots = null;
    else if (Array.isArray(value.camera.shots)) state.camera.shots = readShots(JSON.stringify(value.camera.shots)) ?? null;
    state.camera.autoCut = Boolean(value.camera.autoCut);
  }
  if (isObject(value.hands)) {
    for (const hand of ["left", "right"]) {
      for (const what of ["show", "sound"]) {
        if (typeof value.hands[hand]?.[what] === "boolean") state.hands[hand][what] = value.hands[hand][what];
      }
    }
  }
  if (typeof value.numbers === "boolean") state.numbers = value.numbers;
  if (typeof value.sound === "boolean") state.sound = value.sound;
  state.look = cleanLook(value.look);
  if (isObject(value.corrections)) {
    state.corrections = { fingers: cleanFingers(value.corrections.fingers), hands: cleanHandMoves(value.corrections.hands) };
  }
  state.lesson = cleanLesson(value.lesson);
  if (isObject(value.pose)) for (const hand of ["left", "right"]) state.pose[hand] = cleanPose(value.pose[hand]);
  if (isObject(value.command) && COMMANDS.includes(value.command.type)) {
    state.command = { seq: Number(value.command.seq) || 0, type: value.command.type, by: String(value.command.by ?? "") };
  }
  return state;
}

// Lays a partial change over a state. Objects merge key by key, a null takes
// a key away, and anything else (numbers, arrays, strings) is replaced.
export function mergeState(state, patch) {
  const merge = (into, from) => {
    if (!isObject(from)) return from;
    const out = isObject(into) ? { ...into } : {};
    for (const [key, value] of Object.entries(from)) {
      if (value === null) delete out[key];
      else if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value);
      else out[key] = isObject(value) ? merge({}, value) : value;
    }
    return out;
  };
  // Nulls mean "take away" everywhere but where null is itself a value.
  const merged = merge(state, patch);
  if (patch && "tempo" in patch && patch.tempo === null) merged.tempo = null;
  if (patch?.camera && "shots" in patch.camera && patch.camera.shots === null) merged.camera = { ...merged.camera, shots: null };
  if (patch && "command" in patch && patch.command === null) merged.command = null;
  return cleanState(merged);
}

// The screen as a summary an agent can read: what moment is shown, what each
// hand is doing there, and what has been corrected.
export function projectScreen(score, events, positions, state) {
  const steps = [...new Set(events.filter((event) => event.attack).map((event) => event.time))].sort((a, b) => a - b);
  const at = steps.filter((time) => time <= state.time + 1e-6).at(-1) ?? steps[0] ?? 0;
  const here = events.filter((event) => event.time === at);
  const hands = {};
  for (const hand of ["right", "left"]) {
    let position = null;
    for (const candidate of positions[hand]) if (candidate.startTime <= at) position = candidate;
    const event = [...events].reverse().find((entry) => entry.hand === hand && entry.time <= at);
    const sounding = event && event.time + event.duration > at;
    hands[hand] = {
      notes: sounding ? event.notes.map((note) => ({ note: note.note, finger: note.finger, held: Boolean(note.held), struck: event.time === at && !note.held })) : [],
      fingeringFrom: event?.fingeringSource ?? null,
      position: position ? { measures: `${position.startMeasure}${position.endMeasure !== position.startMeasure ? `–${position.endMeasure}` : ""}`, fingers: position.fingers } : null,
    };
  }
  const first = here[0];
  return {
    score: { title: score.title, measures: score.measures.length, tempo: score.tempo },
    time: at,
    measure: first?.measure ?? null,
    beat: first?.beat ?? null,
    step: { index: steps.indexOf(at), count: steps.length },
    hands,
    corrections: state.corrections,
  };
}
