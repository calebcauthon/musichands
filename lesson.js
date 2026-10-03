// A lesson: a few measures being learnt with the teacher (teacher.js, on the
// server). The lesson under way is kept in the workspace as `lesson`:
// { from, to, style, score }, the measures (by index from 0), the teaching
// style and the piece it is a lesson on. The workspace stores it as given
// and never reads it; the page (learning.js) and the teacher do.
//
// This file is what both sides share: the record, where a passage sits in
// the piece, how notes and fingers are spoken of, and the brief, which is
// what the teacher is told about the music.
import { passageRange } from "./passage.js";
import { cleanStyle } from "./teaching-styles.js";

export const LESSON_MEASURES = 4; // how many measures a lesson takes on by default
export const OVERHEAD = { azimuth: 0, elevation: 87, zoom: 1.35 }; // straight over the hands
export const FINGER_PAUSE = 1400; // ms the page leaves after a finger is placed, for the learner's to get there
export const SLOW_SHARE = 0.5; // a slow start, as a share of the score's tempo

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));

// The lesson to offer from a measure: that one and the few after it.
export function defaultLesson(measureIndex, measureCount) {
  const from = clamp(Math.floor(measureIndex), [0, Math.max(0, measureCount - 1)]);
  return { from, to: Math.min(from + LESSON_MEASURES - 1, Math.max(0, measureCount - 1)) };
}

// A lesson as the workspace holds it, made sound, or null for none.
export function cleanLesson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const from = Number(value.from);
  const to = Number(value.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  return {
    from,
    to,
    style: cleanStyle(value.style),
    ...(typeof value.score === "string" ? { score: value.score } : {}), // the piece it is a lesson on
  };
}

// A slow tempo to start at, given the score's own. Never below the slowest the transport plays.
export function slowTempo(target) {
  return Math.max(30, Math.round(target * SLOW_SHARE));
}

// Which hands a step shows and sounds.
export function stageHands(stage) {
  return {
    left: { show: stage !== "right", sound: stage !== "right" },
    right: { show: stage !== "left", sound: stage !== "left" },
  };
}

// Where the lesson's passage sits in the piece.
export { passageRange as lessonRange };

// ---------------------------------------------------------------------------
// How notes and fingers are spoken of

// A note name the way a teacher would say it: "G", "F sharp", "B flat". The
// octave is left out; the hand on the screen shows which one.
export function spokenNote(note) {
  const match = String(note).match(/^([A-Ga-g])([#b]?)(-?\d)?$/);
  if (!match) return String(note);
  const accidental = match[2] === "#" ? " sharp" : match[2] === "b" ? " flat" : "";
  return `${match[1].toUpperCase()}${accidental}`;
}

// Fingers by the names people call them, never by number; the short names are for several at once.
export const FINGER_NAMES = { 1: "Thumb", 2: "Pointer finger", 3: "Middle finger", 4: "Ring finger", 5: "Pinky" };
export const FINGER_SHORT = { 1: "thumb", 2: "pointer", 3: "middle", 4: "ring", 5: "pinky" };

// The words of a line as they are shown: without the voice's directions.
export function shownText(line) {
  return String(line).replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+([.,;!?])/g, "$1").trim();
}

// ---------------------------------------------------------------------------
// The brief: what the teacher is told about some measures of the piece

const HANDS = ["right", "left"];
const MOST_MOMENTS = 60; // the most moments of a hand listed in one brief

// A moment's name: the score's measure number and the beat within it, as agent.md has it.
export const momentName = (event) => `${event.measure}:${Number.isInteger(event.beat) ? event.beat : Number(event.beat.toFixed(3))}`;

// A hand's events in the range: the moments it plays (attacks), in order.
export function handMoments(events, hand, range) {
  return events.filter((event) => event.hand === hand && event.attack && event.time >= range.start - 1e-6 && event.time < range.end - 1e-6);
}

// The positions a hand takes within the range, in order.
export function handPositions(positions, hand, range) {
  return positions[hand].filter((position) => position.startTime < range.end - 1e-6 && position.endTime > range.start + 1e-6);
}

const fingerOn = (finger, note) => (finger ? `${FINGER_SHORT[finger]} on ${note}` : note);
const fingersOf = (position) => position.fingers.map(({ finger, note }) => fingerOn(finger, note)).join(", ");
const origin = (sources) => (sources.includes("override") ? "corrected by the learner" : sources.includes("score") ? "from the score" : "the app's own choice");

// What one hand does in the measures: where it sits, where it moves, and
// every moment it plays, each with its name so it can be played or
// corrected by it.
function handBrief(hand, { events, positions }, range) {
  const played = handMoments(events, hand, range);
  if (!played.length) return "Does not play in these measures.";
  const taken = handPositions(positions, hand, range);
  const lines = [];
  if (taken.length) lines.push(`Sits at the start with: ${fingersOf(taken[0])} (fingering ${origin(taken[0].sources)}).`);
  // A position that keeps the same fingers on the same keys is not a move.
  const moves = taken.filter((position, index) => index > 0 && fingersOf(position) !== fingersOf(taken[index - 1]));
  for (const position of moves) lines.push(`Moves at ${position.startMeasure}:${position.startBeat} to: ${fingersOf(position)}.`);
  if (taken.length && !moves.length) lines.push("Stays in that position through these measures.");
  lines.push(`Plays, in order (${played.length} ${played.length === 1 ? "moment" : "moments"}; a + joins notes struck together):`);
  for (const event of played.slice(0, MOST_MOMENTS)) {
    const struck = event.notes.filter((note) => !note.held).sort((a, b) => a.midi - b.midi);
    const held = event.notes.filter((note) => note.held);
    const what = struck.length ? struck.map((note) => fingerOn(note.finger, note.note)).join(" + ") : "(nothing new is struck)";
    const keeps = held.length ? `  (still holding ${held.map((note) => note.note).join(", ")})` : "";
    lines.push(`  ${momentName(event).padEnd(7)}${what}${keeps}`);
  }
  if (played.length > MOST_MOMENTS) lines.push(`  … and ${played.length - MOST_MOMENTS} more; ask for fewer measures to see them.`);
  return lines.join("\n");
}

// The brief for a range of the piece, as text the teacher reads. `music` is
// { score, events, positions } with the fingering as it stands, corrections
// and all; `range` is from lessonRange.
export function briefText(music, range) {
  const { score } = music;
  const where = range.from === range.to ? `measure ${range.from}` : `measures ${range.from} to ${range.to}`;
  const title = score.title && score.title !== "Untitled" ? ` of "${score.title}"` : "";
  return [`${where[0].toUpperCase()}${where.slice(1)}${title}.`, "", ...HANDS.flatMap((hand) => [`${hand.toUpperCase()} HAND`, handBrief(hand, music, range), ""])].join("\n").trim();
}
