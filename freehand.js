// The agent's freehand playing: a passage it writes itself, not in the score.
// Each hand gets its notes in order — the keys struck with their fingers, how
// many beats each lasts, and when one does not follow straight on, the beat
// it begins on — and, if the agent wants the hand to hold still, a POSITION:
// where every finger rests, pressed or not. The passage is fingered the way a
// score is (fingering.js), so a run of notes under one hand becomes one steady
// position with all its keys, and the agent's position is laid over that. What
// comes out is the poses the screen plays one after another (workspace-model.js:
// pose), each with the whole hand on its keys and the struck ones pressed.
import { assignFingering } from "./fingering.js";
import { noteToMidi } from "./hand-model.js";
import { FINGER_SHORT } from "./lesson.js";

export const MOST_NOTES = 64; // notes one hand may play in a run
const HANDS = ["right", "left"];
const NOTE = /^[A-G][#b]?-?\d$/;
const LEAST_BEATS = 0.25;
const MOST_BEATS = 8;
const REACH = 14; // semitones a hand stretches, thumb to pinky
const FINGER = /^[1-5]$/;

const fingerName = (finger) => FINGER_SHORT[finger] ?? `finger ${finger}`;
const onKey = (entry) => `${fingerName(entry.finger)} on ${entry.note}`;

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

// The hand's notes as a timeline of events, or why they are not.
function readHand(hand, given, hands) {
  if (hands !== "both" && hands !== hand) return { error: `the ${hand} hand has notes, but hands is "${hands}": name it among the hands, or leave its notes out` };
  const where = (index) => `${hand} hand, note ${index + 1}`;
  const start = readFingers(given.position ?? [], `${hand} hand, position`);
  if (start.error) return start;
  let position = start.fingers;
  let trouble = awkward(position, hand);
  if (trouble) return { error: `${hand} hand, position: ${trouble}` };
  const notes = Array.isArray(given.notes) ? given.notes : [];
  if (!notes.length) return { error: `the ${hand} hand has no notes` };
  if (notes.length > MOST_NOTES) return { error: `the ${hand} hand has ${notes.length} notes; ${MOST_NOTES} at most in one run` };
  const events = [];
  let cursor = 0; // beats from the start, where the next note begins unless it says
  notes.forEach((note, index) => {
    if (events.at(-1)?.error) return;
    const keys = readFingers(note?.keys, where(index));
    if (keys.error) return events.push(keys);
    if (!keys.fingers.length) return events.push({ error: `${where(index)}: no keys` });
    trouble = awkward(keys.fingers, hand);
    if (trouble) return events.push({ error: `${where(index)}: ${trouble}` });
    if (note.position !== undefined) {
      const given = readFingers(note.position, `${where(index)}, position`);
      if (given.error) return events.push(given);
      trouble = awkward(given.fingers, hand);
      if (trouble) return events.push({ error: `${where(index)}, position: ${trouble}` });
      position = given.fingers;
    }
    const at = note.at === undefined || note.at === null ? cursor : Number(note.at) - 1;
    if (!(at >= 0)) return events.push({ error: `${where(index)}: "at" is the beat it begins on, counted from one` });
    const beats = Math.min(MOST_BEATS, Math.max(LEAST_BEATS, Number(note.beats) || 1));
    events.push({ hand, time: at, duration: beats, measure: "1", beat: at + 1, notes: keys.fingers, position });
    cursor = at + beats;
  });
  const failed = events.find((event) => event.error);
  if (failed) return failed;
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

const beatName = (time) => String(Math.round((time + 1) * 100) / 100);

// The whole hand for one event: every key the hand's position covers, the
// agent's position laid over that, and the struck keys under their fingers.
function wholeHand(event, position, hand) {
  const byFinger = new Map();
  for (const entry of position.fingers) byFinger.set(entry.finger, { finger: entry.finger, note: entry.note, midi: noteToMidi(entry.note) });
  for (const entry of event.position) byFinger.set(entry.finger, entry);
  for (const entry of event.notes) byFinger.set(entry.finger, entry);
  // A resting finger gives up a key that is struck by another.
  const struck = new Map(event.notes.map((entry) => [entry.note, entry.finger]));
  for (const [finger, entry] of byFinger) if (struck.has(entry.note) && struck.get(entry.note) !== finger) byFinger.delete(finger);
  const fingers = [...byFinger.values()].sort((a, b) => a.finger - b.finger);
  const trouble = awkward(fingers, hand);
  if (trouble) return { error: `${hand} hand, beat ${beatName(event.time)}: ${trouble}; give the hand a new position from that note` };
  return { fingers: fingers.map(({ finger, note }) => ({ finger, note })) };
}

// The passage as the screen plays it: { tempo, hands, steps }, each step at
// so many ms from the start with, for each hand that changes then, the whole
// hand (fingers), the keys struck (press) and how long they sound (hold); a
// hand whose note has ended is lifted (press []) where it sits. Or { error }.
export function freehandSteps(args = {}) {
  const tempo = Math.min(240, Math.max(30, Math.round(Number(args.tempo) || 0))) || 60;
  const hands = ["right", "left", "both"].includes(args.hands) ? args.hands : null;
  if (!hands) return { error: 'hands must be "right", "left" or "both": the hands seen and heard while it plays' };
  const events = [];
  for (const hand of HANDS) {
    if (args[hand] === undefined || args[hand] === null) continue;
    if (typeof args[hand] !== "object") return { error: `${hand} must be { position, notes }` };
    const read = readHand(hand, args[hand], hands);
    if (read.error) return read;
    events.push(...read.events);
  }
  if (!events.length) return { error: "No notes to play: give right and/or left their notes" };
  events.sort((a, b) => a.time - b.time || (a.hand === "right" ? -1 : 1));

  // Fingered like a score, so a run under one hand is one steady position.
  const fingered = assignFingering(events);
  const whole = new Map(); // event → the whole hand at it
  for (const hand of HANDS) {
    for (const position of fingered.positions[hand]) {
      for (const event of position.events) {
        const result = wholeHand(event, position, hand);
        if (result.error) return result;
        whole.set(event, result.fingers);
      }
    }
  }

  const ms = (beats) => Math.round((beats * 60000) / tempo);
  const times = [...new Set(events.flatMap((event) => [event.time, event.time + event.duration]).map((time) => Math.round(time * 1000) / 1000))].sort((a, b) => a - b);
  const steps = times.map((time) => {
    const step = { ms: ms(time) };
    for (const hand of HANDS) {
      const begins = events.find((event) => event.hand === hand && Math.abs(event.time - time) < 1e-6);
      if (begins) {
        step[hand] = { fingers: whole.get(begins), press: begins.notes.map((entry) => entry.note), hold: ms(begins.duration) };
        continue;
      }
      const ends = events.find((event) => event.hand === hand && Math.abs(event.time + event.duration - time) < 1e-6);
      if (ends) step[hand] = { fingers: whole.get(ends), press: [] };
    }
    return step;
  });
  return { tempo, hands, steps };
}
