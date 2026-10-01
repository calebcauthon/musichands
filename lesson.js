// Learning a passage: a few measures, gone through in steps. A lesson is a
// plan: a list of steps, each with the hands it is about, what is said, what
// is played after it (nothing, the passage a time or two, or the passage on a
// loop, perhaps a little faster at each "got it" until the score's tempo),
// and whether it waits for "got it" or moves on by itself. The plan may be
// written for the passage (lesson-writer.js) or be the ready-made one here:
// the whole passage heard, then each hand that plays — placed a finger at a
// time, its notes shown, played once along, looped up to tempo — then both.
//
// The lesson under way is kept in the workspace as { from, to, step }: the
// measures and how far through the plan it is. The page (learning.js) runs
// it, keeps the camera straight over the hands, and says what to do.
import { passageRange, passageSteps } from "./passage.js";

export const STAGES = ["right", "left", "both"]; // the ready-made lesson takes them in this order
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
  return { from, to: Math.min(from + LESSON_MEASURES - 1, Math.max(0, measureCount - 1)), step: 0 };
}

// A lesson as the workspace holds it, made sound, or null for none. The
// workspace keeps the lesson as it is given (it is this module's own data),
// so it is read through here.
export function cleanLesson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const from = Number(value.from);
  const to = Number(value.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  const step = Number(value.step);
  return {
    from,
    to,
    step: Number.isInteger(step) && step >= 0 ? step : 0,
    ...(typeof value.score === "string" ? { score: value.score } : {}), // the piece it is a lesson on
  };
}

// The tempo a hand starts at, given the score's own. Never below the slowest
// the transport plays.
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

// Which hands a step shows and sounds.
export function stageHands(stage) {
  return {
    left: { show: stage !== "right", sound: stage !== "right" },
    right: { show: stage !== "left", sound: stage !== "left" },
  };
}

// What pressing "got it" does at a step of a plan: in a climb, a little
// faster, until the score's tempo; otherwise, or once there, the next step;
// after the last step, done. Answers the new lesson (null when done), the
// tempo to practise at, and what just happened.
export function advanceLesson(lesson, plan, tempo, target) {
  const step = plan.steps[lesson.step];
  if (step?.climb && tempo < target) {
    const faster = nextTempo(tempo, target);
    return { lesson, tempo: faster, event: faster >= target ? "target" : "faster" };
  }
  const next = plan.steps[lesson.step + 1];
  if (!next) return { lesson: null, tempo: target, event: "done" };
  return { lesson: { ...lesson, step: lesson.step + 1 }, tempo: next.tempo, event: "step" };
}

// Where the lesson's passage sits in the piece and among its steps.
export { passageRange as lessonRange, passageSteps as lessonSteps };

// The workspace `passage` for a step: the lesson's measures, as many times
// as the step plays them (once where it plays nothing, so that Play still
// keeps to the passage).
export function lessonPassage(lesson, step) {
  return { from: lesson.from, to: lesson.to, times: Number.isFinite(step.times) ? Math.max(1, step.times) : null };
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
// Fingers by the names people call them, never by number; the short names are for several at once.
export const FINGER_NAMES = { 1: "Thumb", 2: "Pointer finger", 3: "Middle finger", 4: "Ring finger", 5: "Pinky" };
export const FINGER_SHORT = { 1: "thumb", 2: "pointer", 3: "middle", 4: "ring", 5: "pinky" };
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

// The notes of the passage, finger first: "Pinky on A", "Thumb, middle and
// pinky on A, C and E". Before them, how many there are and the fingers that
// play them. Each different note is explained once, the first time the hand
// plays it, and its line carries the score time of that moment, so the hand
// on the screen can play it as it is named. Then the whole run is said
// through quickly, notes then fingers: "G, C, E, G, C, E with thumb, middle
// and pinky".
function nameNotes(hand, events, range) {
  const played = events.filter((event) => event.hand === hand && event.attack && event.time >= range.start - 1e-6 && event.time < range.end - 1e-6);
  const moments = [];
  for (const event of played.slice(0, NOTES_NAMED)) {
    const struck = event.notes.filter((note) => !note.held).sort((a, b) => a.midi - b.midi);
    if (!struck.length) continue;
    const fingers = struck.map((note) => note.finger).filter(Boolean);
    const fingered = fingers.length === struck.length;
    const notes = list(struck.map((note) => spokenNote(note.note)));
    const chord = struck.length > 1;
    moments.push({
      time: event.time,
      chord,
      // The fingers alone, for the count at the start.
      notes: struck.map((note) => spokenNote(note.note)).join(" "),
      each: fingers,
      fingers: !fingered ? notes : chord ? `${list(fingers.map((finger) => FINGER_SHORT[finger]))} together` : FINGER_NAMES[fingers[0]].toLowerCase(),
      say: !fingered ? `${notes}${chord ? " together" : ""}.` : chord ? `${capital(list(fingers.map((finger) => FINGER_SHORT[finger])))} on ${notes}.` : `${FINGER_NAMES[fingers[0]]} on ${notes}.`,
    });
  }
  if (!moments.length) return [];
  const more = played.length > NOTES_NAMED;
  const chords = moments.filter((moment) => moment.chord).length;
  const what = chords === 0 ? "note" : chords === moments.length ? "chord" : "notes and chord";
  const count = `${more ? "the first " : ""}${moments.length} ${what}${moments.length === 1 ? "" : "s"}`;
  // The same fingers several times running are told once, with how often.
  const runs = [];
  for (const moment of moments) {
    if (runs.at(-1)?.fingers === moment.fingers) runs.at(-1).times += 1;
    else runs.push({ fingers: moment.fingers, times: 1 });
  }
  const often = (times) => (times === 1 ? "" : times === 2 ? ", twice" : `, ${times} times`);
  const told = runs.map((run) => `${run.fingers}${often(run.times)}`).join(chords || runs.some((run) => run.times > 1) ? "; " : ", ");
  const lines = [`Going to hit ${count}: ${told}.`, NOTE_PAUSE];
  const explained = new Set();
  for (const moment of moments) {
    if (explained.has(moment.say)) continue; // by what is said: the same note an octave away sounds the same in words
    explained.add(moment.say);
    lines.push({ say: moment.say, time: moment.time }, NOTE_PAUSE);
  }
  // The run as it goes, said straight through.
  if (moments.length > 1) {
    const used = [...new Set(moments.flatMap((moment) => moment.each))].map((finger) => FINGER_SHORT[finger]);
    lines.push(`${moments.map((moment) => moment.notes).join(", ")}${more ? ", and so on," : ""}${used.length ? ` with ${list(used)}` : ""}.`, NOTE_PAUSE);
  }
  return lines;
}

// What the ready-made lesson says at a phase of a stage: lines to read, with pauses in
// milliseconds between some of them. A line may be `{ say, pose }`, the pose
// being what to show the hands doing as it is said, or `{ say, time }`, the
// moment of the score to play as it is said. `score` has `title` and
// `measures`; `positions` and `events` are the fingered ones; `tempo` is the
// practice tempo and `target` the score's.
function phaseLines(lesson, { score, positions, events, tempo, target, first = lesson.stage === "right" }) {
  const range = passageRange(lesson, score.measures);
  if (!range) return [];
  const where = range.from === range.to ? `measure ${range.from}` : `measures ${range.from} to ${range.to}`;
  if (lesson.phase === "intro") return [`We're going to learn ${where}${score.title && score.title !== "Untitled" ? ` of ${score.title}` : ""}.`, "Here it is at nearly full speed."];
  if (lesson.phase === "show") {
    const times = SHOW_TIMES === 2 ? "twice" : `${SHOW_TIMES} times`;
    if (lesson.stage === "both") return [`Watch both hands together. I'll play it ${times}.`];
    return [...nameNotes(lesson.stage, events, range), `Now watch. I'll play it ${times}.`];
  }
  if (lesson.phase === "once") return [`Now your turn. Once through, slowly, at ${tempo}. Play along.`];
  if (lesson.phase === "ramp") return [`Good. Now it loops. Try ${tempo}; when it's clean, press Got it and we go up ${RAMP} beats a minute at a time, to ${target}.`];
  // Placing the hand.
  const lines = [];
  if (lesson.stage === "both") lines.push("Now both hands together.");
  else if (first) lines.push(`Now let's break it down. ${capital(HAND_NAMES[lesson.stage])} first.`);
  else lines.push(`Now the ${HAND_NAMES[lesson.stage]}.`);
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

// What to say after "got it" in a climb, and when the lesson is done.
export function describeAdvance(event, { tempo, target }) {
  if (event === "faster") return `Now try ${tempo}.`;
  if (event === "target") return `Now try full tempo, ${target}. Press Got it when it's clean.`;
  if (event === "done") return "That's the whole passage, at tempo. Well done.";
  return "";
}

// The ready-made lesson, as a plan: the whole passage heard; then each hand
// that plays, placed, shown, played along once and looped up to tempo; then
// both together, if both play.
export function readyMadePlan(lesson, { score, positions, events, target }) {
  const range = passageRange(lesson, score.measures);
  if (!range) return { steps: [], closing: "" };
  const plays = (hand) => events.some((event) => event.hand === hand && event.attack && event.time >= range.start - 1e-6 && event.time < range.end - 1e-6);
  const stages = STAGES.filter((stage) => (stage === "both" ? plays("right") && plays("left") : plays(stage)));
  const slow = slowTempo(target);
  const said = (stage, phase, tempo) => phaseLines({ ...lesson, stage, phase }, { score, positions, events, tempo, target, first: stage === stages[0] });
  const name = { right: "Right hand", left: "Left hand", both: "Both hands" };
  const steps = [{ label: "The whole passage", hands: "both", lines: said(stages[0] ?? "right", "intro", introTempo(target)), times: 1, tempo: introTempo(target), climb: false, auto: true, button: "", after: "" }];
  for (const stage of stages) {
    const hand = stage === "both" ? "the hands" : "the hand";
    steps.push(
      { label: `${name[stage]} · placing ${hand}`, hands: stage, lines: said(stage, "position", slow), times: 0, tempo: slow, climb: false, auto: false, button: stage === "both" ? "Hands are set" : "Hand is set", after: "" },
      { label: `${name[stage]} · the notes`, hands: stage, lines: said(stage, "show", slow), times: SHOW_TIMES, tempo: slow, climb: false, auto: false, button: "My turn", after: "Press Got it when you're ready to try it, or Play to watch again." },
      { label: `${name[stage]} · your turn`, hands: stage, lines: said(stage, "once", slow), times: 1, tempo: slow, climb: false, auto: false, button: "Loop it", after: "Press Got it when you're ready, or Play to go again." },
      { label: `${name[stage]} · looping`, hands: stage, lines: said(stage, "ramp", slow), times: Infinity, tempo: slow, climb: true, auto: false, button: "Got it", after: "" },
    );
  }
  return { steps, closing: describeAdvance("done", { target }) };
}

// A line for the screen: where the lesson is.
export function describeProgress(step, { tempo, target }) {
  if (!step.times) return step.label;
  if (step.climb) return `${step.label} · ${tempo >= target ? `at full tempo, ${target}` : `${tempo} of ${target}`}`;
  return `${step.label} · at ${tempo}`;
}

// The label for the "got it" button: what pressing it will do.
export function describeNext(step, { tempo, target }) {
  if (step.auto) return "Skip";
  if (step.climb && tempo < target) return "✓ Got it · faster";
  return `✓ ${step.button || "Got it"}`;
}
