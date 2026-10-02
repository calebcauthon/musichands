// A lesson written to order. Instead of the ready-made wording in lesson.js,
// the words of a lesson can be composed by a writer (Claude, through the
// page's `compose`): this file says what the passage holds (the brief), what
// kind of lesson to write and in what voice (the instructions), and turns the
// script that comes back into the lines the lesson speaks, each with what the
// hands on the screen do as it is said.
//
// The voice is ElevenLabs' Eleven v4, which takes directions for the delivery
// in square brackets inside the text; the writer puts those in.
import { FINGER_NAMES, FINGER_PAUSE, FINGER_SHORT, introTempo, lessonRange, NOTE_PAUSE, RAMP, slowTempo, spokenNote } from "./lesson.js";

const HANDS = ["right", "left"];
const NOTES_BRIEFED = 24; // the most moments of a hand's part the writer is told of

// How high a note is, for telling two of the same name apart.
const height = (note) => {
  const match = String(note).match(/^([A-G])([#b]?)(-?\d)$/);
  return match ? Number(match[3]) * 12 + "C D EF G A B".indexOf(match[1]) + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0) : 0;
};

// Notes as the writer is told them: by letter, and where two in the same
// hand share a letter (an octave apart), which is the lower and which the
// higher, since a letter alone would not say.
function tellApart(notes) {
  const names = notes.map((note) => spokenNote(note));
  return notes.map((note, index) => {
    const twins = notes.filter((other, at) => names[at] === names[index]).sort((a, b) => height(a) - height(b));
    if (twins.length < 2) return names[index];
    const place = twins.indexOf(note);
    return `${place === 0 ? "the lower" : place === twins.length - 1 ? "the higher" : "the middle"} ${names[index]}`;
  });
}

// What a hand does in the passage: where it first sits, whether it moves
// after that, and each moment it plays, in order.
function handFacts(hand, { positions, events }, range) {
  const taken = positions[hand].filter((position) => position.startTime < range.end - 1e-6 && position.endTime > range.start + 1e-6);
  const played = events.filter((event) => event.hand === hand && event.attack && event.time >= range.start - 1e-6 && event.time < range.end - 1e-6);
  const moments = [];
  for (const event of played) {
    const struck = event.notes.filter((note) => !note.held).sort((a, b) => a.midi - b.midi);
    if (struck.length) moments.push({ time: event.time, notes: struck.map((note) => ({ note: note.note, finger: note.finger ?? null })) });
  }
  return { fingers: (taken[0]?.fingers ?? []).map(({ finger, note }) => ({ finger, note })), moves: taken.length > 1, moments };
}

// Everything the writer is told about the passage, and the things the hands
// on the screen can be made to do while a line is said, each under a name
// the writer can put beside a line.
export function lessonBrief(lesson, { score, positions, events, target }) {
  const range = lessonRange(lesson, score.measures);
  const hands = Object.fromEntries(HANDS.map((hand) => [hand, handFacts(hand, { positions, events }, range)]));
  const actions = {}; // name → what it does on the screen
  for (const hand of HANDS) {
    const facts = hands[hand];
    for (const entry of facts.fingers) actions[`${hand}:place:${FINGER_SHORT[entry.finger]}`] = { place: { hand, finger: entry.finger, note: entry.note } };
    if (facts.fingers.length) actions[`${hand}:place:hand`] = { rest: { hand } };
    facts.moments.slice(0, NOTES_BRIEFED).forEach((moment, index) => {
      actions[`${hand}:play:${index + 1}`] = { time: moment.time };
    });
  }
  return {
    title: score.title && score.title !== "Untitled" ? score.title : "",
    measures: range.from === range.to ? `measure ${range.from}` : `measures ${range.from} to ${range.to}`,
    tempo: { score: target, intro: introTempo(target), slow: slowTempo(target), step: RAMP },
    hands,
    actions,
  };
}

// The shape of a written part of a lesson: the steps the writer has decided
// on, in order, and a last word (said only if the part ends the lesson).
const line = { type: "object", properties: { say: { type: "string" }, do: { type: "string" } }, required: ["say", "do"], additionalProperties: false };
const step = {
  type: "object",
  properties: {
    label: { type: "string" },
    hands: { type: "string", enum: ["right", "left", "both"] },
    lines: { type: "array", items: line },
    play: { type: "string", enum: ["nothing", "once", "twice", "loop"] },
    until: { type: "string" },
    tempo: { type: "string", enum: ["slow", "nearly full", "full"] },
    climb: { type: "boolean" },
    next: { type: "string", enum: ["got it", "by itself"] },
    button: { type: "string" },
    after: { type: "string" },
  },
  required: ["label", "hands", "lines", "play", "until", "tempo", "climb", "next", "button", "after"],
  additionalProperties: false,
};
export const SCRIPT_SCHEMA = { type: "object", properties: { steps: { type: "array", items: step }, closing: { type: "string" } }, required: ["steps", "closing"], additionalProperties: false };
const MOST_STEPS = 40;

const SYSTEM = `You design and write one part of a short piano lesson on one passage, for one adult learner sitting at a piano with their hands on the keys. The learner is looking at their hands and at a screen that shows a pair of hands playing the same passage from straight above. They cannot read while they play: everything reaches them by ear. Your words are spoken by a text-to-speech voice, one line at a time.

THE TEACHER
Patient, warm, precise, unhurried. Never childish, never gushing. Talks like someone sitting beside the learner, not like a manual. Says one thing at a time and then stops talking so the learner can do it.

THE LESSON AND YOUR PART OF IT
A lesson on a passage goes: (perhaps) the whole passage heard once; then each hand that plays, learnt on its own; then, if both hands play, both together. You are asked for ONE of those parts at a time: one hand's part, or the both-hands part. The other parts are written separately in the same voice, so do not greet, do not sum up the lesson, and stay within your part. The request tells you what came just before your part, so you can open by turning to it in a few words.

YOU DECIDE THE SHAPE OF YOUR PART
A part is a list of steps, in order. You choose which steps this music needs and how many. Fit the teaching to the music: do not run a routine for its own sake.

Each step has:
- "label": a few words shown on the screen for where the lesson is, e.g. "Left hand · placing the hand".
- "hands": which hands are shown and heard during the step: "right", "left" or "both".
- "lines": what you say, in order (see LINES).
- "play": what the app plays right after your last line: "nothing", "once", "twice", or "loop" (over and over until the learner moves on).
- "until": how far into the passage that playing goes. "" plays the whole passage. The name of a "play" action (e.g. "right:play:2") plays from the start of the passage up to and including that moment, and stops there. This is how you teach a piece at a time.
- "tempo": how fast that is: "slow" (half the score's tempo), "nearly full" or "full".
- "climb": true only with "loop": each press of the Got it button makes the loop a little faster, until the score's tempo, and only then does the lesson move on. Otherwise false.
- "next": "got it" (wait for the learner to press the Got it button) or "by itself" (move on as soon as the playing ends; only with "once" or "twice").
- "button": two or three words for the Got it button in this step, e.g. "Hand is set", "My turn", "Got it". "" when next is "by itself".
- "after": one short line said when the playing ends and the lesson is waiting, e.g. "Press Got it when you're ready, or Play to hear it again." Give it on the FIRST step of your part that waits after playing, and leave it "" on the rest: the learner knows by then. Also "" when nothing plays, when it loops, or when next is "by itself".
"closing" is one short line said when the whole lesson is done. Write it only if the request says your part is the last; otherwise "".

ONE THING AT A TIME — THIS IS THE HEART OF IT
Never hand the learner a whole measure at once. Teach by adding one thing at a time:
1. "Let's get THIS note." Put the one finger it needs on its key (a "place" action) and name it. That is a whole step: one finger, one note. Let them play it.
2. Add the next. Name only the NEW note, finger first, with its "play" action so the hand on the screen shows it. Then play from the start up to that note ("until" that moment) so they hear the two joined, and let them try. Wait for Got it.
3. Add another, the same way. And another. Each step adds one new moment (or two when the second is a repeat of something already learnt, or trivially easy) and plays everything so far.
4. Only when the whole of a hand's part has been built up this way does the whole passage get played, and only then is there any looping or work on tempo.
Say what is NEW in a step, not what they already have. Do not list the notes still to come. Do not announce how many notes there are in total. A learner should never have more than one new thing in their head.

Hand position works the same way: do not place all five fingers before anything is played. Place the finger for the note being learnt; place another when its note arrives. If the next note is under a finger that is already down, just say which finger.

THE KINDS OF STEP YOU CAN BUILD
- Getting one note: place its finger (a "place" action), name it, play just that moment once ("until" it). Wait for Got it.
- Adding a note: name the new one (with its "play" action), then play from the start up to it, once or twice, slowly. Wait for Got it. Where the join is awkward, loop it instead.
- The whole part: once everything is built, play the passage once slowly for them to play along; then, if speed is a difficulty, a loop with a climb.
- Both hands (when that is your part): each hand is already learnt. Put them together the same patient way: place both hands, the first moment together, then add the next, playing up to it each time; then the whole thing; then a loop with a climb.
These can be merged, split, reordered or left out.

USE YOUR JUDGEMENT
- A hand whose part is one note or one chord has nothing to build and no tempo to work up. Place the finger, play it, done: two steps.
- A moment that repeats the one before it is not a new thing: add it together with the next new one, or just say "and again".
- Use the climb only where speed is actually the difficulty: several notes in a row, or hands to coordinate.
- When you place a whole hand rather than one finger, do it one finger per line, each with its own "place" action.
- Keep each step small, but do not pad with steps that teach nothing.

LINES
Each line has "say" (the words) and "do" (the name of one thing the hands on the screen do as the line is said, or "" for nothing). Use only the action names given in the brief, exactly as written, in full. A "place" action puts that finger on its key on the screen (the app leaves a pause after it for the learner to do the same); a "play" action makes the hand on the screen play that moment as you say the line.
Each line is one short sentence, rarely more than twelve words, and a step has few lines: often two or three. No preamble, no recap of what was just done, no filler praise. Tell the learner what the Got it button is for the first time a step waits on it; after that they know.

HOW TO TALK ABOUT FINGERS AND NOTES
- Fingers are called: thumb, pointer finger, middle finger, ring finger, pinky. Never by number, never "finger 2".
- Always the finger first, then the note: "Thumb on C", never "C with your thumb".
- Notes are just their letter names: "C", "F sharp", "B flat". Never an octave number. Where the brief says "the lower A" or "the higher A", two keys under the hand share a name: keep that wording so the learner knows which.
- For several fingers at once: "Thumb, middle and pinky on A, C and E."
- Write every number as a word ("sixty", "three"), since it will be read aloud.

THE VOICE (ElevenLabs Eleven v4)
You may direct the delivery with audio tags in square brackets inside "say", such as [warmly], [calm, unhurried], [encouraging], [gently], [short pause]. Rules:
- Tags must describe something you can HEAR (tone, pace, a pause, a breath). Nothing visual.
- Put a tag just before the words it colours. Use them sparingly: most lines need none, and a line never needs more than one or two. No sound effects, laughing, singing or accents.
- An ellipsis (...) adds a small pause and weight. CAPITALS add emphasis; use at most a word here and there.
- No SSML, no markup of any other kind.
- The note A must be heard as the letter, not the word "a": keep it capital and place it so it cannot be mistaken ("Thumb on A.").`;

// What to ask the writer for one part of a lesson on this passage (a hand's,
// or both hands'): instructions, the request, and the shape the answer must
// take. `before` is the part that comes just before it ("intro", a hand, or
// nothing), and `last` whether it ends the lesson.
export function writerRequest(brief, part, { before = null, last = false } = {}) {
  const hand = (name) => {
    const facts = brief.hands[name];
    if (!facts.moments.length) return "Does not play in this passage.";
    const sits = tellApart(facts.fingers.map((entry) => entry.note));
    const fingers = facts.fingers.map((entry, index) => `  - ${FINGER_NAMES[entry.finger].toLowerCase()} on ${sits[index]}  →  action "${name}:place:${FINGER_SHORT[entry.finger]}"`).join("\n");
    const played = facts.moments
      .slice(0, NOTES_BRIEFED)
      .map((moment, index) => {
        const told = tellApart(moment.notes.map((note) => note.note));
        return `  ${index + 1}. ${moment.notes.map((note, at) => `${note.finger ? `${FINGER_NAMES[note.finger].toLowerCase()} on ` : ""}${told[at]}`).join(" + ")}  →  action "${name}:play:${index + 1}"`;
      })
      .join("\n");
    const more = facts.moments.length > NOTES_BRIEFED ? `\n  (and ${facts.moments.length - NOTES_BRIEFED} more after these; say "and so on")` : "";
    return `Where it sits at the start:\n${fingers}\n  whole hand put on those keys at once  →  action "${name}:place:hand"\n${facts.moves ? "It moves to other positions later in the passage." : "It stays in this position for the whole passage."}\nWhat it plays, in order (a + joins notes struck together), ${facts.moments.length} ${facts.moments.length === 1 ? "moment" : "moments"} in all:\n${played}${more}`;
  };
  const came = {
    intro: "Just before your part, the learner heard the whole passage played once, both hands. Open by turning from that to the breakdown.",
    right: "Just before your part, the learner finished learning the right hand on its own.",
    left: "Just before your part, the learner finished learning the left hand on its own.",
  }[before] ?? "Your part opens the lesson: nothing has been said or played yet. Say in a few words what is about to be learnt.";
  const others = HANDS.filter((name) => name !== part && brief.hands[name].moments.length);
  const asked =
    part === "both"
      ? `Write the BOTH HANDS part: the two hands, each already learnt on its own, put together. Use "both" for the hands of every step.\n\nRIGHT HAND\n${hand("right")}\n\nLEFT HAND\n${hand("left")}`
      : `Write the ${part.toUpperCase()} HAND's part: that hand on its own. Use "${part}" for the hands of every step.${others.length ? ` The ${others[0]} hand also plays in this passage and is taught in its own part.` : " It is the only hand that plays in this passage."}\n\n${part.toUpperCase()} HAND\n${hand(part)}`;
  const prompt = `${asked}

${came}
${last ? "Your part is the LAST of the lesson: write the closing line." : 'Another part follows yours: leave "closing" empty.'}

PASSAGE
${brief.title ? `Piece: ${brief.title}\n` : ""}What is being learnt: ${brief.measures}
The score's tempo: ${brief.tempo.score} beats a minute ("full"); "nearly full" is ${brief.tempo.intro}; "slow" is ${brief.tempo.slow}; each Got it in a climb adds ${brief.tempo.step}.`;
  return { system: SYSTEM, prompt, schema: SCRIPT_SCHEMA };
}

// A step's lines as the lesson speaks them: strings, pauses in milliseconds,
// and `{ say, pose }` or `{ say, time }` for what the hands do as a line is
// said.
function spokenItems(written, hands, brief) {
  const placed = { right: [], left: [] }; // the fingers put down so far, as the lines go
  const out = [];
  for (const entry of Array.isArray(written) ? written : []) {
    const say = String(entry?.say ?? "").trim();
    if (!say) continue;
    const action = brief.actions[String(entry?.do ?? "")];
    if (action?.place) {
      const { hand, finger, note } = action.place;
      if (!placed[hand].some((known) => known.finger === finger)) placed[hand].push({ finger, note });
      out.push({ say, pose: { [hand]: { fingers: [...placed[hand]].sort((a, b) => a.finger - b.finger), press: [note] } } }, FINGER_PAUSE);
    } else if (action?.rest) {
      const { hand } = action.rest;
      const { fingers } = brief.hands[hand];
      // On its own the whole hand rests on its keys; with both hands, the outer fingers press to show where it sits.
      const press = hands === "both" ? [...new Set([fingers[0].note, fingers.at(-1).note])] : [];
      out.push({ say, pose: { [hand]: { fingers, press } } }, ...(hands === "both" ? [FINGER_PAUSE] : []));
    } else if (action?.time !== undefined) {
      out.push({ say, time: action.time }, NOTE_PAUSE);
    } else out.push(say);
  }
  return out;
}

// A part as the writer designed it, as steps the lesson can run (see
// lesson.js for the shape), with its last word. Whatever does not make sense
// is put right or left out; null if nothing usable was written, so that the
// ready-made steps can step in.
export function planFromScript(script, brief) {
  if (!Array.isArray(script?.steps)) return null;
  const tempos = { slow: brief.tempo.slow, "nearly full": brief.tempo.intro, full: brief.tempo.score };
  const steps = [];
  for (const written of script.steps.slice(0, MOST_STEPS)) {
    const hands = ["right", "left", "both"].includes(written?.hands) ? written.hands : "both";
    const lines = spokenItems(written?.lines, hands, brief);
    const times = { nothing: 0, once: 1, twice: 2, loop: Infinity }[written?.play] ?? 0;
    if (!lines.length && !times) continue;
    const loops = times === Infinity;
    // Playing up to a moment stops where the next thing the step's hands play would begin.
    const until = brief.actions[String(written?.until ?? "")]?.time;
    const later = until === undefined ? [] : (hands === "both" ? HANDS : [hands]).flatMap((hand) => brief.hands[hand].moments.map((moment) => moment.time)).filter((time) => time > until + 1e-6);
    steps.push({
      label: String(written?.label ?? "").trim().slice(0, 60) || (hands === "both" ? "Both hands" : hands === "right" ? "Right hand" : "Left hand"),
      hands,
      lines,
      times,
      end: later.length ? Math.min(...later) : null, // null: the whole passage
      tempo: tempos[written?.tempo] ?? brief.tempo.slow,
      climb: loops && written?.climb === true,
      auto: !loops && times > 0 && written?.next === "by itself", // only something that ends can move on by itself
      button: String(written?.button ?? "").trim().slice(0, 24),
      after: String(written?.after ?? "").trim(),
    });
  }
  return steps.length ? { steps, closing: String(script.closing ?? "").trim() } : null;
}

// The words of a line as they are shown: without the voice's directions.
export function shownText(line) {
  return String(line).replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+([.,;!?])/g, "$1").trim();
}
