// The teacher: an agent that knows the music, has the screen's tools, is
// given a way of teaching, and talks with the learner. One session per
// workspace, kept here in memory while the lesson lasts.
//
// The teacher is a model reached through `model(messages, tools)` (an
// OpenAI-style chat completion with tool calls; see openRouterModel in
// server.js). Its tools are of two kinds. Some change the workspace and are
// done here at once: looking at the music, correcting a fingering, moving a
// note to the other hand, changing which measures the lesson is on, ending
// the lesson. The rest happen on the screen — saying something, placing a
// hand, playing a moment, playing the passage, a pause — and are sent to the
// browsers watching as "acts"; the lead browser performs each and reports it
// done, which is when the tool answers. So the teacher really waits for the
// playing to end.
//
// Whatever the learner says (a word spoken into the microphone, a line
// typed, the Got it button) arrives through say(). If the teacher is
// listening, that answers it. If an act is under way, the act is cut short:
// it answers "interrupted, the learner said …", the other acts of that turn
// are skipped, and the teacher answers the learner. Plain text from the
// teacher is spoken and then the teacher listens, so an ordinary exchange
// costs one call.
import { matchingMoments } from "./corrections.js";
import { briefText, cleanLesson, FINGER_PAUSE, FINGER_SHORT, handMoments, lessonRange, momentName, NO_LESSON, OVERHEAD, slowTempo, stageHands } from "./lesson.js";
import { findStyle } from "./teaching-styles.js";

export const ACT_WAIT = 10 * 60 * 1000; // ms an act waits for a browser before it is given up
const QUIET_TURNS = 30; // turns without a word from the learner before the teacher is made to listen
const MOST_PAUSE = 10; // seconds
const NOTE = /^[A-G][#b]?-?\d$/;
const HANDS = ["right", "left", "both"];
const NO_POSE = { left: null, right: null };

// ---------------------------------------------------------------------------
// What the teacher is told

const MANNER = `You are a piano teacher, sitting beside one adult learner who is at a piano with their hands on the keys. They are looking at their hands and at a screen that shows a pair of hands playing the piece from straight above, with the notation beside it. They cannot read while they play: everything reaches them by ear, through a text-to-speech voice that reads what you say.

THE TEACHER
Patient, warm, precise, unhurried. Never childish, never gushing. Talks like someone sitting beside the learner, not like a manual. Says one thing at a time and then stops talking so the learner can do it. No preamble, no recap, no filler praise. Short sentences, rarely more than twelve words.

ONE THING AT A TIME
Never hand the learner a whole measure at once. Teach by adding one thing: the one finger a note needs, placed and named (finger first, then the note), the moment played so they hear it, their turn; then the next note the same way, playing from the start up to it so the join is heard; and so on. Say what is NEW, not what they already have. Do not list the notes still to come or announce how many there are. A moment that repeats the one before is not a new thing. Only when a hand has its whole part is there any looping or work on tempo, and only where speed is actually the difficulty.

HOW TO TALK ABOUT FINGERS AND NOTES
- Fingers are called thumb, pointer finger, middle finger, ring finger, pinky. Never by number.
- Always the finger first, then the note: "Thumb on C", never "C with your thumb".
- The brief names notes with their octave (C4, F#3) so that your tools can be exact. To the learner, say only the letter: "C", "F sharp", "B flat", never an octave number. Where two keys under the hand share a letter, say "the lower A" and "the higher A".
- For several fingers at once: "Thumb, middle and pinky on A, C and E."
- Write every number as a word ("sixty", "three"), since it will be read aloud.

THE VOICE (ElevenLabs Eleven v4)
In what you say you may direct the delivery with audio tags in square brackets, such as [warmly], [calm, unhurried], [encouraging], [gently], [short pause]. A tag must describe something that can be HEARD (tone, pace, a pause, a breath), goes just before the words it colours, and is used sparingly: most lines need none. An ellipsis (...) adds a small pause and weight. No SSML, no sound effects, no singing. The note A must be heard as the letter: keep it capital and place it so it cannot be mistaken ("Thumb on A.").

THE TOOLS
Everything you do for the learner is a tool call. Every word you write outside a tool call is read aloud to the learner as well, before the calls are made: so never write notes to yourself, plans, or remarks about the learner — only what you would say to their face. A reply with words and no tool call is spoken and then you wait for the learner, so a plain reply is the way to answer them. Use the tools like this:
- say: speak. One short thing at a time. The learner is waiting for you to stop talking.
- place: put a hand on the screen where you say, finger by finger as you name them, so the learner can copy it. Place the finger for the note being learnt; place the next when its note arrives. After naming a finger, pause a moment for the learner's finger to get there. fingers: [] gives the hand back to the score.
- play_moment: the hands on the screen play one moment — one note or chord and nothing after it — as you name it. This is how to let the learner hear just the note being learnt.
- play: the hands on the screen play some measures, or the stretch from one moment up to another (two or three notes, say), at a tempo, a number of times, or looped. It returns when the playing has played out — or sooner, if the learner says something, with their words. A loop returns only when they do. The learner plays along with it, or watches, as you have told them.
- pause: a silence of a few seconds, for the learner to do something.
- listen: wait for the learner. They press Got it (which reaches you as "Got it.") or say something. Tell them what Got it is for the first time you wait on it; after that they know. Do not wait for them after every sentence; wait when there is something for them to do.
- look: the brief for other measures, when the lesson moves beyond what you were given.
- change_fingering, move_note: change the fingering the hands on the screen use, at one moment or everywhere that hand plays the same notes. Do it when the learner asks for another fingering, or when you judge the one given awkward. The screen and the brief change with it.
- focus: tell the screen which measures the lesson is on now.
- done: end the lesson, with a last word.
If a tool answers that the learner spoke (interrupted, or skipped with their words), take it as them answering you — "Got it." is them saying they are ready — and carry on from what they said. If it answers with an error, read it and try differently. Tempos are beats a minute; the slowest is thirty, and a slow start is about half the score's tempo.

THE LEARNER CAN TURN THE LESSON
The learner can speak at any time. Follow them: another fingering, another spot, slower, again, just one hand, skip ahead. Keep the teaching style you were given unless they ask for something else, and do not argue with them about it.`;

// The system prompt for a lesson: the manner, the style, and the brief.
export function teacherPrompt({ style, brief, tempo }) {
  return `${MANNER}

THE WAY OF TEACHING ASKED FOR: ${style.name}
${style.instructions}

THE MUSIC
The score's tempo is ${tempo} beats a minute; a slow start is ${slowTempo(tempo)}. Moments are named measure:beat — 3:1 is the first beat of measure 3, 3:2.5 the "and" after its second beat — and tools take them by that name.

${brief}`;
}

// The first thing the learner is heard to say.
export function openingMessage({ style, range, said }) {
  const where = range.from === range.to ? `measure ${range.from}` : `measures ${range.from} to ${range.to}`;
  return `The learner has chosen ${where} and the way of teaching "${style.name}". ${said ? `They said: "${said}"` : "They said nothing more."} Begin.`;
}

// ---------------------------------------------------------------------------
// The tools, as the model is told them (OpenAI function-calling schemas)

const schema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name, description, parameters) => ({ type: "function", function: { name, description, parameters } });
const measure = (what) => ({ type: "string", description: `${what}, by the score's measure number as the learner sees it.` });
const hands = { type: "string", enum: HANDS, description: "Which hands are shown and heard." };

export const TOOLS = [
  tool("say", "Speak to the learner. One short thing.", schema({ text: { type: "string" } })),
  tool("pause", "A silence, for the learner to do something.", schema({ seconds: { type: "number", minimum: 0.5, maximum: MOST_PAUSE } })),
  tool(
    "place",
    "Put a hand on the screen where you say: which finger on which key, and which keys are pressed. Shown while nothing is playing. fingers: [] gives the hand back to the score.",
    schema({
      hand: { type: "string", enum: ["right", "left"] },
      fingers: { type: "array", items: schema({ finger: { type: "integer", minimum: 1, maximum: 5 }, note: { type: "string", description: "Letter, accidental and octave, e.g. C4, F#3, Bb2." } }) },
      press: { type: "array", items: { type: "string" }, description: "The notes among those that are held down, usually the one just placed." },
    }),
  ),
  tool("play_moment", "The hands on the screen play one moment of the piece: just that note or chord, nothing after it.", schema({ moment: { type: "string", description: "measure:beat" }, hands })),
  tool(
    "play",
    "The hands on the screen play the measures, or the stretch between two moments, at a tempo, so many times or looped. Returns when played out, or when the learner says something. For one note or chord use play_moment instead.",
    schema(
      {
        from_measure: measure("The first measure to play"),
        to_measure: measure("The last measure to play"),
        from_moment: { type: "string", description: "Start at this moment (measure:beat) instead of the first measure's start. \"\" to start at the measure." },
        until_moment: { type: "string", description: "Stop after this moment (measure:beat) instead of playing the measures to their end. \"\" for the whole of them. With from_moment, this plays just a few notes." },
        hands,
        tempo: { type: "integer", minimum: 30, maximum: 240, description: "Beats a minute." },
        times: { type: "integer", minimum: 1, maximum: 10, description: "How many times through. Ignored when loop is true." },
        loop: { type: "boolean", description: "Over and over, until the learner says something." },
      },
      ["from_measure", "to_measure", "hands", "tempo", "times", "loop"],
    ),
  ),
  tool("listen", "Wait for the learner to say something or press Got it.", schema({})),
  tool("look", "The brief for some measures: where each hand sits and every moment it plays, with the fingering as it stands.", schema({ from_measure: measure("The first measure"), to_measure: measure("The last measure") })),
  tool(
    "change_fingering",
    "Change which finger plays a note at a moment, on the screen and in the brief. With everywhere, at every moment where that hand plays the same notes.",
    schema({ moment: { type: "string", description: "measure:beat" }, hand: { type: "string", enum: ["right", "left"] }, note: { type: "string", description: "e.g. C4" }, finger: { type: "integer", minimum: 1, maximum: 5 }, everywhere: { type: "boolean" } }),
  ),
  tool("move_note", "Give a note at a moment to the other hand.", schema({ moment: { type: "string", description: "measure:beat" }, note: { type: "string", description: "e.g. C4" }, hand: { type: "string", enum: ["right", "left"], description: "The hand to play it." } })),
  tool("focus", "Tell the screen which measures the lesson is on now.", schema({ from_measure: measure("The first measure"), to_measure: measure("The last measure") })),
  tool("done", "End the lesson.", schema({ closing: { type: "string", description: "A last word, spoken." } })),
];

export const ACTS = ["say", "pause", "place", "play_moment", "play"]; // the tools the screen performs

// ---------------------------------------------------------------------------

function send(response, event, data) {
  try {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // The watcher has gone.
  }
}

const parseArguments = (text) => {
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

export class Teacher {
  // model(messages, tools) answers the assistant's message { content, tool_calls }.
  // music(record) answers { score, events, positions, tempo } for the piece
  // the workspace has open; patch(record, state) lays a change over it.
  constructor({ model, music, patch }) {
    this.model = model;
    this.music = music;
    this.patch = patch;
    this.sessions = new Map(); // workspace id → session
  }

  session(record) {
    return this.sessions.get(record.id) ?? null;
  }

  // What a page needs to join a lesson under way.
  status(record) {
    const session = this.session(record);
    if (!session) return { on: false };
    return { on: true, lesson: session.lesson, status: session.status, ...(session.error ? { error: session.error } : {}), transcript: session.transcript, acts: [...session.pending.values()].map((entry) => entry.act) };
  }

  // Begins a lesson. Throws when one is on, or the workspace has no music.
  async start(record, { from, to, style, said = "" } = {}) {
    if (this.session(record)) throw new Error("A lesson is already under way in this workspace");
    const lesson = cleanLesson({ mode: "teacher", from, to, style, score: record.state.score?.id ?? "" });
    if (!lesson) throw new Error("Say which measures: { from, to }, by index from 0");
    const music = await this.music(record);
    const range = lessonRange(lesson, music.score.measures);
    if (!range) throw new Error("The piece has no measures");
    const chosen = findStyle(lesson.style);
    const words = String(said ?? "").trim().slice(0, 2000);
    const session = {
      id: record.id,
      record,
      lesson,
      status: "thinking",
      error: "",
      transcript: [],
      watchers: new Set(),
      inbox: [], // what the learner has said and the teacher has not yet heard
      hearing: null, // resolves with the next thing the learner says
      pending: new Map(), // act id → { act, resolve }
      serial: 0,
      quiet: 0, // turns since the learner last said anything
      ended: false,
      messages: [
        { role: "system", content: teacherPrompt({ style: chosen, brief: briefText(music, range), tempo: music.tempo }) },
        { role: "user", content: openingMessage({ style: chosen, range, said: words }) },
      ],
    };
    this.sessions.set(record.id, session);
    // The screen is set for the lesson: the passage, seen from straight above.
    await this.patch(record, { lesson, passage: { from: lesson.from, to: lesson.to, times: 1, start: null, end: null }, time: range.start, playing: false, tempo: null, pose: NO_POSE, hands: stageHands("both"), camera: { view: { ...OVERHEAD }, autoCut: false } });
    if (words) this.tell(session, "said", { who: "learner", text: words });
    session.running = this.run(session).catch((error) => {
      console.error("MusicHands: the teacher stopped.", error);
      this.end(session, "failed", { error: error.message });
    });
    return this.status(record);
  }

  watch(record, response) {
    const session = this.session(record);
    if (!session) return null;
    session.watchers.add(response);
    // An act waiting on a screen is shown to a screen that has just arrived.
    for (const { act } of session.pending.values()) send(response, "act", act);
    return () => session.watchers.delete(response);
  }

  tell(session, event, data) {
    if (event === "said") {
      data = { n: session.transcript.length, ...data }; // numbered, so a page can put late and early copies in order
      session.transcript.push(data);
    }
    if (event === "status") {
      session.status = data.status;
      session.error = data.error ?? "";
    }
    for (const response of session.watchers) send(response, event, data);
  }

  // The learner says something. If the teacher is listening, it hears it; if
  // an act is under way, the act is cut short with it; otherwise it waits to
  // be heard.
  say(record, text) {
    const session = this.session(record);
    if (!session) throw new Error("No lesson is under way");
    const words = String(text ?? "").trim().slice(0, 2000);
    if (!words) throw new Error("Say something: { text }");
    this.tell(session, "said", { who: "learner", text: words });
    const pending = [...session.pending.values()];
    if (session.hearing) {
      const { resolve } = session.hearing;
      session.hearing = null;
      resolve(words);
    } else if (pending.length) {
      // The acts under way are cut short, the first with the learner's words.
      for (const [index, entry] of pending.entries()) {
        this.tell(session, "cut", { id: entry.act.id });
        session.pending.delete(entry.act.id);
        entry.resolve(index === 0 ? { interrupted: true, learner_said: words } : { skipped: true, reason: "the learner spoke first" });
      }
    } else session.inbox.push(words);
    return { heard: true };
  }

  // The lead browser reports an act done.
  done(record, id, result = {}) {
    const session = this.session(record);
    if (!session) throw new Error("No lesson is under way");
    const entry = session.pending.get(String(id));
    if (!entry) return { done: false }; // cut short already, or not this lesson's
    session.pending.delete(entry.act.id);
    entry.resolve(result && typeof result === "object" ? result : { done: true });
    return { done: true };
  }

  // After someone else has changed the workspace: a lesson they ended, or
  // turned to another piece, ends the teacher's too.
  settle(record) {
    const session = this.session(record);
    const kept = cleanLesson(record.state.lesson);
    if (session && (kept?.mode !== "teacher" || record.state.score?.id !== session.lesson.score)) this.stop(record, "stopped").catch(() => {});
  }

  // Ends a lesson from outside (Stop, the page opened afresh, the workspace gone).
  async stop(record, reason = "stopped") {
    const session = this.session(record);
    if (!session) return false;
    await this.end(session, reason);
    return true;
  }

  async end(session, reason, data = {}) {
    if (session.ended) return;
    session.ended = true;
    this.sessions.delete(session.id);
    for (const entry of session.pending.values()) entry.resolve({ skipped: true, reason: "the lesson ended" });
    session.pending.clear();
    if (session.hearing) session.hearing.resolve(null);
    session.status = reason === "done" ? "done" : reason;
    try {
      if (reason !== "removed") await this.patch(session.record, NO_LESSON);
    } finally {
      for (const response of session.watchers) send(response, "ended", { reason, ...data });
      session.watchers.clear();
    }
  }

  // Waits for the next thing the learner says; null when the lesson ends
  // first. Said to be listening unless the status should stay as it is.
  hear(session, { quietly = false } = {}) {
    if (session.inbox.length) return Promise.resolve(session.inbox.shift());
    if (session.ended) return Promise.resolve(null);
    if (!quietly) this.tell(session, "status", { status: "listening" });
    return new Promise((resolve) => (session.hearing = { resolve }));
  }

  // Sends an act to the screen and waits for it to be done, cut short, or
  // given up. Something the learner has already said cuts it short at once.
  perform(session, act) {
    if (session.ended) return Promise.resolve({ skipped: true, reason: "the lesson ended" });
    if (session.inbox.length) return Promise.resolve({ interrupted: true, reason: "the learner spoke before this began; answer them", learner_said: session.inbox.shift() });
    const id = String(++session.serial);
    const sent = { id, ...act };
    this.tell(session, "status", { status: act.type === "say" ? "speaking" : act.type === "play" || act.type === "play_moment" ? "playing" : "waiting", act: sent });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!session.pending.has(id)) return;
        session.pending.delete(id);
        resolve({ error: "No screen performed this: is a browser open on the workspace?" });
      }, ACT_WAIT);
      timer.unref?.();
      session.pending.set(id, {
        act: sent,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      this.tell(session, "act", sent);
    });
  }

  // The lesson: ask the model, do what it says, tell it what happened, again.
  async run(session) {
    while (!session.ended) {
      this.tell(session, "status", { status: "thinking" });
      let reply;
      try {
        reply = await this.model(session.messages, TOOLS);
      } catch (error) {
        // Said on the panel; the next word from the learner (Got it will do) tries again.
        this.tell(session, "status", { status: "failed", error: error.message });
        const words = await this.hear(session, { quietly: true });
        if (words === null) return;
        session.messages.push({ role: "user", content: words });
        continue;
      }
      const text = String(reply?.content ?? "").trim();
      const calls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : [];
      session.messages.push({ role: "assistant", content: reply?.content ?? "", ...(calls.length ? { tool_calls: calls } : {}), ...(reply?.reasoning_details ? { reasoning_details: reply.reasoning_details } : {}) });
      session.quiet += 1;
      if (!calls.length) {
        // Plain words are spoken, then it is the learner's turn.
        let words = null;
        if (text) {
          this.tell(session, "said", { who: "teacher", text });
          const outcome = await this.perform(session, { type: "say", text });
          if (outcome?.interrupted) words = outcome.learner_said;
        }
        words ??= await this.hear(session);
        if (words === null) return;
        session.quiet = 0;
        session.messages.push({ role: "user", content: words });
        continue;
      }
      // Words that come with tool calls are spoken before the calls are made.
      const results = [];
      let cut = false;
      let heard = null; // what the learner said, when they cut those words short
      if (text) {
        this.tell(session, "said", { who: "teacher", text });
        const outcome = await this.perform(session, { type: "say", text });
        if (outcome?.interrupted) {
          cut = true;
          heard = outcome.learner_said;
        }
      }
      for (const call of calls) {
        const name = call.function?.name ?? "";
        let outcome;
        if (session.ended) outcome = { skipped: true, reason: "the lesson ended" };
        else if (heard !== null) {
          outcome = { skipped: true, reason: "the learner spoke while you were saying that; answer them", learner_said: heard };
          heard = null;
        } else if (cut) outcome = { skipped: true, reason: "the learner spoke first" };
        else {
          try {
            outcome = await this.runTool(session, name, parseArguments(call.function?.arguments));
          } catch (error) {
            outcome = { error: error.message };
          }
          if (outcome?.interrupted) cut = true;
        }
        if (name === "listen" || outcome?.interrupted) session.quiet = 0;
        results.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome ?? { done: true }) });
      }
      session.messages.push(...results);
      if (session.quiet >= QUIET_TURNS && !session.ended) {
        // Going on and on without the learner: made to listen.
        const words = await this.hear(session);
        if (words === null) return;
        session.quiet = 0;
        session.messages.push({ role: "user", content: words });
      }
    }
  }

  // One tool call, done here or on the screen. Answers what the model is told.
  async runTool(session, name, args) {
    const { record } = session;
    switch (name) {
      case "say": {
        const text = String(args.text ?? "").trim();
        if (!text) return { error: "Nothing to say" };
        this.tell(session, "said", { who: "teacher", text });
        return this.perform(session, { type: "say", text });
      }
      case "pause": {
        const seconds = Math.min(MOST_PAUSE, Math.max(0.5, Number(args.seconds) || 1));
        return this.perform(session, { type: "pause", ms: Math.round(seconds * 1000) });
      }
      case "place": {
        if (!["right", "left"].includes(args.hand)) return { error: "hand must be right or left" };
        const fingers = (Array.isArray(args.fingers) ? args.fingers : []).map((entry) => ({ finger: Number(entry?.finger), note: String(entry?.note ?? "") })).filter((entry) => [1, 2, 3, 4, 5].includes(entry.finger) && NOTE.test(entry.note));
        const press = (Array.isArray(args.press) ? args.press : []).map(String).filter((note) => fingers.some((entry) => entry.note === note));
        return this.perform(session, { type: "place", hand: args.hand, fingers, press, pauseMs: fingers.length ? FINGER_PAUSE : 0 });
      }
      case "play_moment": {
        const music = await this.music(record);
        const which = HANDS.includes(args.hands) ? args.hands : "both";
        const event = this.findMoment(music, args.moment, which);
        if (!event) return { error: `No moment ${args.moment} is played by ${which === "both" ? "either hand" : `the ${which} hand`}` };
        return this.perform(session, { type: "play_moment", time: event.time, hands: which, moment: momentName(event) });
      }
      case "play": {
        const music = await this.music(record);
        const span = this.findMeasures(music, args.from_measure, args.to_measure);
        if (span.error) return span;
        const which = HANDS.includes(args.hands) ? args.hands : "both";
        const range = lessonRange(span, music.score.measures);
        const missing = (name) => ({ error: `No moment ${name} is played by ${which === "both" ? "either hand" : `the ${which} hand`} in measures ${range.from} to ${range.to}` });
        let start = null;
        if (args.from_moment) {
          const from = this.findMoment(music, args.from_moment, which, range);
          if (!from) return missing(args.from_moment);
          start = from.time;
        }
        let end = null;
        if (args.until_moment) {
          const until = this.findMoment(music, args.until_moment, which, range);
          if (!until) return missing(args.until_moment);
          if (start !== null && until.time < start) return { error: `${args.until_moment} comes before ${args.from_moment}` };
          // Playing up to a moment stops where the next thing those hands play would begin, or where that moment is over.
          const later = (which === "both" ? ["right", "left"] : [which]).flatMap((hand) => handMoments(music.events, hand, range)).map((event) => event.time).filter((time) => time > until.time + 1e-6);
          end = Math.min(later.length ? Math.min(...later) : Infinity, until.time + until.duration);
          if (end >= range.end - 1e-6) end = null;
        }
        const loop = args.loop === true;
        const tempo = Math.min(240, Math.max(30, Math.round(Number(args.tempo) || slowTempo(music.tempo))));
        const times = loop ? null : Math.min(10, Math.max(1, Math.round(Number(args.times) || 1)));
        return this.perform(session, { type: "play", from: span.from, to: span.to, start, end, hands: which, tempo, times, loop });
      }
      case "listen": {
        const words = await this.hear(session);
        return words === null ? { skipped: true, reason: "the lesson ended" } : { said: words };
      }
      case "look": {
        const music = await this.music(record);
        const span = this.findMeasures(music, args.from_measure, args.to_measure);
        if (span.error) return span;
        return { brief: briefText(music, lessonRange(span, music.score.measures)) };
      }
      case "change_fingering": {
        const music = await this.music(record);
        if (!["right", "left"].includes(args.hand)) return { error: "hand must be right or left" };
        const finger = Number(args.finger);
        if (![1, 2, 3, 4, 5].includes(finger)) return { error: "finger must be 1 to 5" };
        const note = String(args.note ?? "");
        const event = this.findMoment(music, args.moment, args.hand);
        if (!event) return { error: `The ${args.hand} hand plays nothing at ${args.moment}` };
        if (!event.notes.some((entry) => entry.note === note)) return { error: `The ${args.hand} hand does not play ${note} at ${momentName(event)}; it plays ${event.notes.map((entry) => entry.note).join(", ")}` };
        const moments = args.everywhere === true ? matchingMoments(music.events, event) : [event];
        const fingers = {};
        for (const moment of moments) fingers[momentName(moment)] = { [args.hand]: { [note]: finger } };
        await this.patch(record, { corrections: { fingers } });
        return this.fingeredNow(record, args.hand, momentName(event), { changed: moments.length });
      }
      case "move_note": {
        const music = await this.music(record);
        if (!["right", "left"].includes(args.hand)) return { error: "hand must be right or left" };
        const note = String(args.note ?? "");
        const other = args.hand === "right" ? "left" : "right";
        const event = this.findMoment(music, args.moment, other);
        if (!event || !event.notes.some((entry) => entry.note === note)) return { error: `The ${other} hand does not play ${note} at ${args.moment}` };
        await this.patch(record, { corrections: { hands: { [momentName(event)]: { [note]: args.hand } } } });
        return this.fingeredNow(record, args.hand, momentName(event), { moved: note });
      }
      case "focus": {
        const music = await this.music(record);
        const span = this.findMeasures(music, args.from_measure, args.to_measure);
        if (span.error) return span;
        session.lesson = { ...session.lesson, from: span.from, to: span.to };
        await this.patch(record, { lesson: session.lesson, passage: { from: span.from, to: span.to, times: 1, start: null, end: null } });
        return { focus: `measures ${lessonRange(span, music.score.measures).from} to ${lessonRange(span, music.score.measures).to}` };
      }
      case "done": {
        const closing = String(args.closing ?? "").trim();
        if (closing) {
          this.tell(session, "said", { who: "teacher", text: closing });
          await this.perform(session, { type: "say", text: closing });
        }
        await this.end(session, "done");
        return { done: true };
      }
      default:
        return { error: `No such tool: ${name}` };
    }
  }

  // The measures named, as a passage by index: { from, to }, or an error.
  findMeasures(music, fromNumber, toNumber) {
    const { measures } = music.score;
    const index = (number) => measures.findIndex((measure) => String(measure.number) === String(number ?? "").trim());
    const from = index(fromNumber);
    const to = toNumber === undefined || toNumber === "" ? from : index(toNumber);
    if (from < 0 || to < 0) return { error: `No such measure: the piece has measures ${measures[0]?.number} to ${measures.at(-1)?.number}` };
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  // The moment named, as played by that hand (or either), within `range` if given.
  findMoment(music, name, hands, range = null) {
    const wanted = String(name ?? "").trim();
    return (
      music.events.find((event) => {
        if (!event.attack || momentName(event) !== wanted) return false;
        if (hands !== "both" && event.hand !== hands) return false;
        return !range || (event.time >= range.start - 1e-6 && event.time < range.end - 1e-6);
      }) ?? null
    );
  }

  // The hand's fingering at a moment, as it now stands.
  async fingeredNow(record, hand, moment, extra = {}) {
    const music = await this.music(record);
    const event = this.findMoment(music, moment, hand);
    const position = music.positions[hand].filter((candidate) => candidate.startTime <= (event?.time ?? 0) + 1e-6).at(-1);
    return {
      ...extra,
      moment,
      [hand]: event ? event.notes.map((note) => `${FINGER_SHORT[note.finger] ?? "?"} on ${note.note}`).join(" + ") : "nothing",
      position: position ? position.fingers.map(({ finger, note }) => `${FINGER_SHORT[finger]} on ${note}`).join(", ") : "",
    };
  }
}
