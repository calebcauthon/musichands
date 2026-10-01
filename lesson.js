// Learning a passage: a few measures. First the whole passage is played,
// both hands, at nearly full speed, to hear where this is going; then it is
// broken down, one hand at a time and then both.
// Each hand goes through four phases, and "got it" moves on: the hand is
// placed one finger at a time; the notes are named and played one by one, and
// the passage shown a couple of times; the passage is played through once,
// slowly, for the player to join in; then it loops, a little faster at each
// "got it" until the score's own tempo.
// The lesson is part of the workspace, so the page and any agent see the same
// one; the page plays the passage, keeps the camera straight over the hands,
// and says what to do.
import { passageRange, passageSteps } from "./passage.js";

export const STAGES = ["right", "left", "both"]; // in this order
export const PHASES = ["intro", "position", "show", "once", "ramp"]; // the whole passage heard; placing the hand; the notes named and the passage shown; once through, slowly; looping and climbing to the score's tempo
export const INTRO_SHARE = 0.9; // "nearly full speed", as a share of the score's tempo
export const FINGER_PAUSE = 1400; // ms the voice leaves after naming a finger, for the finger to get there
export const NOTE_PAUSE = 800; // ms after naming a note, as it sounds
export const SHOW_TIMES = 2; // how many times the passage is played to show it
export const NOTES_NAMED = 16; // the most moments named one by one before "and so on"
export const RAMP = 3; // beats a minute added at each "got it" while climbing
export const SLOW_SHARE = 0.5; // the starting tempo, as a share of the score's
export const LESSON_MEASURES = 4; // how many measures a lesson takes on by default
export const OVERHEAD = { azimuth: 0, elevation: 87, zoom: 1.35 }; // straight over the hands

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));

// The lesson to offer from a measure: that one and the few after it.
export function defaultLesson(measureIndex, measureCount) {
  const from = clamp(Math.floor(measureIndex), [0, Math.max(0, measureCount - 1)]);
  return { from, to: Math.min(from + LESSON_MEASURES - 1, Math.max(0, measureCount - 1)), stage: "right", phase: "intro" };
}

// A lesson as the workspace holds it, made sound, or null for none. The
// workspace keeps the lesson as it is given (it is this module's own data),
// so it is read through here.
export function cleanLesson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const from = Number(value.from);
  const to = Number(value.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  return {
    from,
    to,
    stage: STAGES.includes(value.stage) ? value.stage : "right",
    phase: PHASES.includes(value.phase) ? value.phase : "intro",
    ...(typeof value.score === "string" ? { score: value.score } : {}), // the piece it is a lesson on
  };
}

// The tempo a stage starts at, given the score's own. Never below the
// slowest the transport plays.
export function slowTempo(target) {
  return Math.max(30, Math.round(target * SLOW_SHARE));
}

// The tempo the whole passage is first heard at.
export function introTempo(target) {
  return Math.max(30, Math.round(target * INTRO_SHARE));
}

// The tempo after one more "got it" while climbing.
export function nextTempo(tempo, target) {
  return Math.min(target, tempo + RAMP);
}

// Which hands a stage shows and sounds.
export function stageHands(stage) {
  return {
    left: { show: stage !== "right", sound: stage !== "right" },
    right: { show: stage !== "left", sound: stage !== "left" },
  };
}

// Which hands a lesson shows and sounds where it stands: both while the whole
// passage is heard, then the stage's.
export function lessonHands(lesson) {
  return stageHands(lesson.phase === "intro" ? "both" : lesson.stage);
}

// What pressing "got it" does (the introduction moves on by itself once it
// has played, as if it had been pressed): heard whole → the first hand; the
// hand placed → the notes shown; shown →
// once through, slowly; heard once → looping at that tempo; looping → a little
// faster, until the score's
// tempo; at the score's tempo → the next hand, placed afresh; after the last
// hand → done. Answers the new lesson (null when done), the tempo to practise
// at, and what just happened, for the voice.
export function advanceLesson(lesson, tempo, target) {
  if (lesson.phase === "intro") return { lesson: { ...lesson, stage: STAGES[0], phase: "position" }, tempo: slowTempo(target), event: "breakdown" };
  if (lesson.phase === "position") return { lesson: { ...lesson, phase: "show" }, tempo: slowTempo(target), event: "show" };
  if (lesson.phase === "show") return { lesson: { ...lesson, phase: "once" }, tempo, event: "once" };
  if (lesson.phase === "once") return { lesson: { ...lesson, phase: "ramp" }, tempo, event: "ramp" };
  if (tempo < target) {
    const faster = nextTempo(tempo, target);
    return { lesson, tempo: faster, event: faster >= target ? "target" : "faster" };
  }
  const next = STAGES[STAGES.indexOf(lesson.stage) + 1];
  if (!next) return { lesson: null, tempo: target, event: "done" };
  return { lesson: { ...lesson, stage: next, phase: "position" }, tempo: slowTempo(target), event: "stage" };
}

// How many times a phase plays the passage: a couple to show it, once for
// the player to join in, Infinity when it loops, 0 when it does not play.
export function phasePlays(phase) {
  return { intro: 1, show: SHOW_TIMES, once: 1, ramp: Infinity }[phase] ?? 0;
}

// Where the lesson's passage sits in the piece and among its steps.
export { passageRange as lessonRange, passageSteps as lessonSteps };

// The workspace `passage` for where the lesson stands: its measures, as many
// times as the phase plays them (once where the phase does not play, so that
// Play still keeps to the passage).
export function lessonPassage(lesson) {
  const times = phasePlays(lesson.phase);
  return { from: lesson.from, to: lesson.to, times: Number.isFinite(times) ? Math.max(1, times) : null };
}

// ---------------------------------------------------------------------------
// What the voice says

// A note name the way a teacher would say it: "G", "F sharp", "B flat". The
// octave is left out; the hand on the screen shows which one.
export function spokenNote(note) {
  const match = String(note).match(/^([A-Ga-g])([#b]?)(-?\d)?$/);
  if (!match) return String(note);
  const accidental = match[2] === "#" ? " sharp" : match[2] === "b" ? " flat" : "";
  return `${match[1].toUpperCase()}${accidental}`;
}

const HAND_NAMES = { right: "right hand", left: "left hand", both: "both hands" };
const FINGER_NAMES = { 1: "Thumb", 2: "Finger 2", 3: "Finger 3", 4: "Finger 4", 5: "Pinky" };
const capital = (text) => text[0].toUpperCase() + text.slice(1);

// The positions a hand takes through the passage, in order.
function positionsIn(positions, range) {
  return positions.filter((position) => position.startTime < range.end - 1e-6 && position.endTime > range.start + 1e-6);
}

// The outer fingers of a position: the thumb and the pinky when they are placed.
function anchors(position) {
  const named = (entry) => `${FINGER_NAMES[entry.finger].toLowerCase()} on ${spokenNote(entry.note)}`;
  const { fingers } = position; // in finger order, so the thumb comes first and the pinky last
  return fingers.length <= 2 ? fingers.map(named).join(" and ") : `${named(fingers[0])} and ${named(fingers.at(-1))}`;
}

// Placing one hand: each finger of its first position in turn, with time to
// get there. As each is named, the hand on the screen gets that finger too,
// pressing its key: the line carries the pose to show (see "pose" in
// workspace-model.js).
function placeHand(hand, positions, range) {
  const taken = positionsIn(positions, range);
  if (!taken.length) return [`The ${HAND_NAMES[hand]} rests through this passage.`];
  const lines = [];
  const placed = [];
  for (const entry of taken[0].fingers) {
    placed.push({ finger: entry.finger, note: entry.note });
    lines.push({ say: `${FINGER_NAMES[entry.finger]} on ${spokenNote(entry.note)}.`, pose: { [hand]: { fingers: [...placed], press: [entry.note] } } }, FINGER_PAUSE);
  }
  // The whole hand at rest on its keys.
  lines.push({ say: taken.length > 1 ? "It moves later on; we'll take that as it comes." : "That's the position.", pose: { [hand]: { fingers: placed, press: [] } } });
  return lines;
}

const list = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// The notes of the passage in the order the hand plays them, each with its
// finger. Each line carries the score time of its moment, so the hand on the
// screen can play it as it is named. A moment the same as the last is "Again".
function nameNotes(hand, events, range) {
  const played = events.filter((event) => event.hand === hand && event.attack && event.time >= range.start - 1e-6 && event.time < range.end - 1e-6);
  const lines = [];
  let last = null;
  for (const event of played.slice(0, NOTES_NAMED)) {
    const struck = event.notes.filter((note) => !note.held).sort((a, b) => a.midi - b.midi);
    if (!struck.length) continue;
    const same = struck.map((note) => `${note.midi}:${note.finger}`).join(",");
    const fingers = struck.map((note) => note.finger).filter(Boolean);
    let say;
    if (same === last) say = "Again.";
    else if (struck.length === 1) say = `${spokenNote(struck[0].note)}${fingers.length ? `, ${FINGER_NAMES[fingers[0]].toLowerCase()}` : ""}.`;
    else say = `${list(struck.map((note) => spokenNote(note.note)))} together${fingers.length === struck.length ? `, fingers ${list(fingers)}` : ""}.`;
    last = same;
    lines.push({ say, time: event.time }, NOTE_PAUSE);
  }
  if (played.length > NOTES_NAMED) lines.push("And so on.");
  return lines;
}

// What the voice says as a phase begins: lines to read, with pauses in
// milliseconds between some of them. A line may be `{ say, pose }`, the pose
// being what to show the hands doing as it is said, or `{ say, time }`, the
// moment of the score to play as it is said. `score` has `title` and
// `measures`; `positions` and `events` are the fingered ones; `tempo` is the
// practice tempo and `target` the score's.
export function phaseLines(lesson, { score, positions, events, tempo, target }) {
  const range = passageRange(lesson, score.measures);
  if (!range) return [];
  const where = range.from === range.to ? `measure ${range.from}` : `measures ${range.from} to ${range.to}`;
  if (lesson.phase === "intro") return [`We're going to learn ${where}${score.title && score.title !== "Untitled" ? ` of ${score.title}` : ""}.`, "Here it is at nearly full speed."];
  if (lesson.phase === "show") {
    const times = SHOW_TIMES === 2 ? "twice" : `${SHOW_TIMES} times`;
    if (lesson.stage === "both") return [`Watch both hands together. I'll play it ${times}.`];
    return ["Here are the notes.", ...nameNotes(lesson.stage, events, range), `Now watch. I'll play it ${times}.`];
  }
  if (lesson.phase === "once") return [`Now your turn. Once through, slowly, at ${tempo}. Play along.`];
  if (lesson.phase === "ramp") return [`Good. Now it loops. Try ${tempo}; when it's clean, press Got it and we go up ${RAMP} beats a minute at a time, to ${target}.`];
  // Placing the hand.
  const lines = [];
  if (lesson.stage === "right") lines.push("Now let's break it down. Right hand first.");
  else if (lesson.stage === "left") lines.push("Now the left hand.");
  else lines.push("Now both hands together.");
  if (lesson.stage === "both") {
    // Each hand has been learnt on its own: just where they sit, the outer fingers pressed.
    for (const hand of ["right", "left"]) {
      const taken = positionsIn(positions[hand], range);
      if (!taken.length) {
        lines.push(`The ${HAND_NAMES[hand]} rests.`, FINGER_PAUSE);
        continue;
      }
      const { fingers } = taken[0];
      const outer = [...new Set([fingers[0].note, fingers.at(-1).note])];
      lines.push({ say: `${capital(HAND_NAMES[hand])}: ${anchors(taken[0])}.`, pose: { [hand]: { fingers: fingers.map(({ finger, note }) => ({ finger, note })), press: outer } } }, FINGER_PAUSE);
    }
    lines.push("Press Got it when both hands are set.");
  } else {
    lines.push(...placeHand(lesson.stage, positions[lesson.stage], range));
    lines.push("Press Got it when your hand is set.");
  }
  return lines;
}

// What to say after "got it" when no new phase begins: `event` is what
// advanceLesson answered.
export function describeAdvance(event, { tempo, target }) {
  if (event === "faster") return `Now try ${tempo}.`;
  if (event === "target") return `Now try full tempo, ${target}. Press Got it when it's clean.`;
  if (event === "done") return "That's the whole passage, both hands, at tempo. Well done.";
  return "";
}

// What to say when the passage has played out, in a phase where it does.
export function describePlayed(phase) {
  if (phase === "show") return "Press Got it when you're ready to try it, or Play to watch again.";
  if (phase === "once") return "Press Got it when you're ready, or Play to go again.";
  return "";
}

// A line for the screen: where the lesson is.
export function describeProgress(lesson, { tempo, target }) {
  if (lesson.phase === "intro") return `The whole passage · at ${tempo}`;
  const stage = lesson.stage === "both" ? "Both hands" : lesson.stage === "right" ? "Right hand" : "Left hand";
  if (lesson.phase === "position") return `${stage} · placing ${lesson.stage === "both" ? "the hands" : "the hand"}`;
  if (lesson.phase === "show") return `${stage} · the notes`;
  if (lesson.phase === "once") return `${stage} · your turn, once through at ${tempo}`;
  return `${stage} · ${tempo >= target ? `at full tempo, ${target}` : `looping · ${tempo} of ${target}`}`;
}

// The label for the "got it" button: what pressing it will do.
export function describeNext(lesson, { tempo, target }) {
  if (lesson.phase === "intro") return "Skip · break it down";
  if (lesson.phase === "position") return lesson.stage === "both" ? "✓ Hands are set" : "✓ Hand is set";
  if (lesson.phase === "show") return "✓ Got it · my turn";
  if (lesson.phase === "once") return "✓ Got it · loop it";
  if (tempo < target) return "✓ Got it · faster";
  return lesson.stage === "both" ? "✓ Got it · finish" : "✓ Got it · next hand";
}
