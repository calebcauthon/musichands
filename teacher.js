// The agent on the server: it knows the music, has the screen's tools, keeps
// notes, and talks with the person at the piano. There is one of it in a
// workspace, there all the time: it answers what the person asks and does
// what they ask, and does not teach. A LESSON is laid over it: handed a
// passage and a way of teaching, it is told how to teach, given two more
// tools (focus, done), and sets the screen up; when the lesson ends the
// instructions are taken away again and it is simply there as before. The
// conversation runs on across both.
//
// The conversation is kept only while it is warm. A call to the model that
// would come long after the last one (STALE_AFTER) finds nothing of the old
// conversation in the model's cache, so it is not sent again: the messages
// are rebuilt from the system prompt and whatever the learner has said since,
// with a word that the earlier talk was lost. What lasts are the agent's
// NOTES, about the person and about the workspace, which it writes itself
// and reads at the start of every conversation.
//
// The agent is a model reached through `model(messages, tools)` (an
// OpenAI-style chat completion with tool calls; see openRouterModel in
// server.js). Its tools are of two kinds. Some change the workspace and are
// done here at once: looking at the music, seeing or changing the screen,
// correcting a fingering, moving a note to the other hand, writing a note,
// moving the lesson. The rest happen on the screen — saying something,
// placing a hand, playing a moment, playing some measures, a pause — and are
// sent to the browsers watching as "acts"; the lead browser performs each
// and reports it done, which is when the tool answers. So the agent really
// waits for the playing to end.
//
// Whatever the learner says (a word spoken into the microphone, a line
// typed, the Got it button) arrives through say(). If the agent is
// listening, that answers it. If an act is under way, the act is cut short:
// it answers "interrupted, the learner said …", the other acts of that turn
// are skipped, and the agent answers the learner. Plain text from the agent
// is spoken and then the agent listens, so an ordinary exchange costs one
// call. Every word of the learner's reaches the model with a line saying
// what is on the screen as they speak.
import { matchingMoments } from "./corrections.js";
import { briefText, cleanLesson, defaultLesson, FINGER_PAUSE, FINGER_SHORT, handMoments, lessonRange, momentName, NO_LESSON, OVERHEAD, slowTempo, stageHands } from "./lesson.js";
import { freehandSteps, MOST_NOTES as MOST_FREEHAND_NOTES } from "./freehand.js";
import { findStyle, STYLES } from "./teaching-styles.js";

export const ACT_WAIT = 10 * 60 * 1000; // ms an act waits for a browser before it is given up
export const STALE_AFTER = 5 * 60 * 1000; // ms after the model's last reply before the conversation is dropped rather than sent again
export const MOST_NOTES = 1500; // characters a set of notes may run to
const QUIET_TURNS = 30; // turns without a word from the learner before the agent is made to listen
const MOST_MESSAGES = 200; // a conversation longer than this loses its oldest turns
const KEPT_MESSAGES = 140; // down to about this many
const MOST_PAUSE = 10; // seconds
const NOTE = /^[A-G][#b]?-?\d$/;
const HANDS = ["right", "left", "both"];
const ABOUT = ["person", "workspace"];
const NO_POSE = { left: null, right: null };
const VIEWS = { overhead: OVERHEAD, player: { azimuth: 0, elevation: 72, zoom: 1 }, bass: { azimuth: -40, elevation: 36, zoom: 1.25 }, treble: { azimuth: 44, elevation: 32, zoom: 1.2 } };
const LOOK_KINDS = { piano: ["ebony", "white", "rosewood", "crimson"], build: ["man", "woman"], skin: ["fair", "olive", "brown", "dark"], outfit: ["suit", "tuxedo", "linen", "clown"], gloves: ["none", "white", "black"], scene: ["stage", "park", "hall"] };

// ---------------------------------------------------------------------------
// What the agent is told

const WHO = `You are beside one adult at a piano. They are working on a piece with a screen that shows a pair of hands playing it, with the notation beside it. The screen is theirs: they move about the piece, play it, step through it, choose a hand, change a fingering, as they please. You are company who knows the music and can work the screen: you answer what they ask and do what they ask — go to a measure, play something, slower, one hand, show a fingering, change it, say what the hands do here, look ahead — and otherwise you keep quiet. You know music in general as well as this piece — keys, scales, chords, intervals, how a passage is built — and answer such questions plainly; when it helps to hear or see what you mean, the hands play it with play_notes, in the piece or not. You do not teach unless they ask you to; when they do, a LESSON begins (see below, if one is on) and you lead it. They cannot read while they play: everything reaches them by ear, through a text-to-speech voice that reads what you say.

THE MANNER
Plain, warm, precise, unhurried. Never childish, never gushing. Talks like someone sitting beside them, not like a manual. Says what was asked and no more; a word or two is often enough. Does not announce what it is about to do; does it, and says a word. No preamble, no recap, no filler praise. Short sentences, rarely more than twelve words. When a question is answered by doing something on the screen, do that.

WHERE THEY ARE
Every message from them ends with a line in parentheses saying what is on the screen as they speak: the measure and beat, what each hand has there, whether the music is playing, which hands are shown, the tempo. "Here", "this", "this note", "this chord" mean that. They may have moved since you last looked, so trust that line over what you remember.

HOW TO TALK ABOUT FINGERS AND NOTES
- Fingers are called thumb, pointer finger, middle finger, ring finger, pinky. Never by number.
- Always the finger first, then the note: "Thumb on C", never "C with your thumb".
- The brief names notes with their octave (C4, F#3) so that your tools can be exact. To the learner, say only the letter: "C", "F sharp", "B flat", never an octave number. Where two keys under the hand share a letter, say "the lower A" and "the higher A".
- For several fingers at once: "Thumb, middle and pinky on A, C and E."
- Write every number as a word ("sixty", "three"), since it will be read aloud.

THE VOICE (ElevenLabs Eleven v4)
In what you say you may direct the delivery with audio tags in square brackets, such as [warmly], [calm, unhurried], [encouraging], [gently], [short pause]. A tag must describe something that can be HEARD (tone, pace, a pause, a breath), goes just before the words it colours, and is used sparingly: most lines need none. An ellipsis (...) adds a small pause and weight. No SSML, no sound effects, no singing. The note A must be heard as the letter: keep it capital and place it so it cannot be mistaken ("Thumb on A.").

THE TOOLS
Everything you do on the screen is a tool call. Every word you write outside a tool call is read aloud to them as well, before the calls are made: so never write notes to yourself, plans, or remarks about them — only what you would say to their face. A reply with words and no tool call is spoken and then you wait for them, so a plain reply is the way to answer a question. Use the tools like this:
- say: speak. One short thing at a time. They are waiting for you to stop talking.
- see: what is on the screen now, in full: where they are, what each hand has there, whether it is playing, the tempo, the hands, the camera, the passage Play keeps to. Their messages carry the short form of this, so you rarely need it.
- screen: change the screen: go to a measure or a moment, set the tempo, choose the hands, finger numbers, sound, the camera, the passage Play keeps to, stop the music, the look of the stage. Send only what should change. This is how to do what they ask when it is not playing something.
- play: the hands on the screen play some measures, or the stretch from one moment up to another (two or three notes, say), at a tempo, a number of times, or looped. It returns when the playing has played out — or sooner, if they say something, with their words. A loop returns only when they do. They play along with it, or watch, as you have told them.
- play_notes: the hands on the screen play anything you write, freehand, at a tempo: a scale, a chord, an arpeggio, a run, a bit of the piece changed to show a point. It is sheet music of your own, not shown: each hand gets its notes in order (the keys struck, a finger each, and how many beats), and a position — where every finger rests — when the hand should hold still, as a pianist's does; without one, the hand sits over the keys it plays. Only the hands you name are seen and heard, so one hand alone is one hand alone. For the piece as written, use play or play_moment instead.
- play_moment: the hands on the screen play one moment — one note or chord and nothing after it — as you name it.
- place: put a hand on the screen where you say, finger by finger as you name them, so they can copy it. The pressed keys sound once as the hand lands; it is a picture of a hand, not a performance. After naming a finger, pause a moment for theirs to get there. fingers: [] gives the hand back to the score.
- To be HEARD, play: play_moment for one note or chord of the piece, play for a stretch of it, play_notes for anything not in it. "Let me show you" means one of these, not place.
- pause: a silence of a few seconds, for them to do something.
- listen: wait for them to say something. After a plain reply you wait anyway. Do not wait after every sentence; wait when there is something for them to do.
- look: the brief for some measures: where each hand sits and every moment it plays, with the fingering as it stands. A few measures at a time.
- change_fingering, move_note: change the fingering the hands on the screen use, at one moment or everywhere that hand plays the same notes, or give a note to the other hand. Do it when they ask for another fingering, or in a lesson when you judge the one given awkward. The screen and the brief change with it.
- remember: rewrite one of your two sets of notes (see WHAT YOU REMEMBER).
- teach (when no lesson is on): they ask to be taught some measures, or for a lesson: begin one, with the measures, a way of teaching, and what they asked for in their words.
- focus, done (in a lesson): tell the screen which measures the lesson is on now; end the lesson, with a last word.
If a tool answers that they spoke (interrupted, or skipped with their words), take it as them talking to you — in a lesson, "Got it." is them saying they are ready — and carry on from what they said. If it answers with an error, read it and try differently. Tempos are beats a minute; the slowest is thirty, and a slow start is about half the score's tempo.`;

const NOTES_RULES = `WHAT YOU REMEMBER
Conversations do not last: this one began just now, and when they go away for a while it is dropped. What lasts is your notes, two short sets you keep with remember. About THE PERSON: how they like to be talked to, what they are working towards, what comes hard, what they have asked you not to do; these follow them to every workspace of theirs. About THIS WORKSPACE: the piece they are on, the fingering they settled on and why, where they left off, what to pick up next time. Rewrite a set in full when you learn something worth keeping — not every turn, and never what the brief or the screen already tells you. Short lines. Here they are as they stand.`;

const LESSON_RULES = `THE LESSON
A lesson is on. You are the teacher now: patient, precise, one thing at a time, and you lead; the rest of the manner holds.

ONE THING AT A TIME
Never hand the learner a whole measure at once. Teach by adding one thing: the one finger a note needs, placed and named (finger first, then the note), the moment played so they hear it, their turn; then the next note the same way, playing from the start up to it so the join is heard; and so on. Say what is NEW, not what they already have. Do not list the notes still to come or announce how many there are. A moment that repeats the one before is not a new thing. Only when a hand has its whole part is there any looping or work on tempo, and only where speed is actually the difficulty.

GOT IT
When you wait for them (listen, or a plain reply), they press Got it (which reaches you as "Got it.") or say something. Tell them what Got it is for the first time you wait on it; after that they know.

THE LEARNER CAN TURN THE LESSON
The learner can speak at any time. Follow them: another fingering, another spot, slower, again, just one hand, skip ahead. Keep the teaching style you were given unless they ask for something else, and do not argue with them about it. When the lesson is finished, or they want to stop, call done.`;

const MOMENTS = `Moments are named measure:beat — 3:1 is the first beat of measure 3, 3:2.5 the "and" after its second beat — and tools take them by that name.`;

const notesText = (text) => (String(text ?? "").trim() ? String(text).trim() : "(nothing yet)");

// The system prompt: who the agent is, what it remembers, the piece and the
// brief for the measures the learner is at, and, when one is on, the lesson.
export function agentPrompt({ score, tempo, brief, notes, lesson = null }) {
  const title = score.title && score.title !== "Untitled" ? `"${score.title}"` : "an untitled piece";
  const parts = [
    WHO,
    `${NOTES_RULES}\n\nAbout the person:\n${notesText(notes.person)}\n\nAbout this workspace:\n${notesText(notes.workspace)}`,
    `THE MUSIC\nThe piece is ${title}: measures ${score.measures[0]?.number} to ${score.measures.at(-1)?.number}. The score's tempo is ${tempo} beats a minute; a slow start is ${slowTempo(tempo)}. ${MOMENTS} Below is the brief for the measures they were at when this conversation began; look gives it for any others.\n\n${brief}`,
  ];
  if (lesson) {
    parts.push(LESSON_RULES, `THE WAY OF TEACHING ASKED FOR: ${lesson.style.name}\n${lesson.style.instructions}`, `THE PASSAGE OF THE LESSON\n${lesson.brief}`);
  }
  return parts.join("\n\n");
}

// The first thing the learner is heard to say in a lesson.
export function openingMessage({ style, range, said }) {
  const where = range.from === range.to ? `measure ${range.from}` : `measures ${range.from} to ${range.to}`;
  return `The learner has chosen ${where} and the way of teaching "${style.name}". ${said ? `They said: "${said}"` : "They said nothing more."} Begin.`;
}

// ---------------------------------------------------------------------------
// The tools, as the model is told them (OpenAI function-calling schemas)

const schema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const optional = (properties) => schema(properties, []);
const tool = (name, description, parameters) => ({ type: "function", function: { name, description, parameters } });
const measure = (what) => ({ type: "string", description: `${what}, by the score's measure number as the learner sees it.` });
const hands = { type: "string", enum: HANDS, description: "Which hands are shown and heard." };
const fingerOnKey = schema({ finger: { type: "integer", minimum: 1, maximum: 5 }, note: { type: "string", description: "Letter, accidental and octave, e.g. C4, F#3, Bb2." } });
const position = (when) => ({ type: "array", items: fingerOnKey, description: `Where the whole hand sits ${when}: the key each finger rests on, pressed or not, so the hand holds still like a pianist's. Name every finger whose place matters; a finger left out goes where the notes it plays put it.` });
// One hand's part of play_notes: its notes in order, and where it sits.
const handPart = schema(
  {
    position: position("from the first note on, until a note gives a new one"),
    notes: {
      type: "array",
      minItems: 1,
      maxItems: MOST_FREEHAND_NOTES,
      items: schema(
        {
          keys: { type: "array", minItems: 1, items: fingerOnKey, description: "The keys struck, a finger each: one for a note, several for a chord." },
          beats: { type: "number", minimum: 0.25, maximum: 8, description: "How long it lasts, in beats." },
          at: { type: "number", minimum: 1, description: "The beat it begins on, counted from one through the run. Left out, it begins as the note before ends; a later beat leaves a rest." },
          position: position("from this note on"),
        },
        ["keys", "beats"],
      ),
    },
  },
  ["notes"],
);

// The tools the agent always has.
export const TOOLS = [
  tool("say", "Speak to the learner. One short thing.", schema({ text: { type: "string" } })),
  tool("pause", "A silence, for the learner to do something.", schema({ seconds: { type: "number", minimum: 0.5, maximum: MOST_PAUSE } })),
  tool(
    "place",
    "Put a hand on the screen where you say: which finger on which key, and which keys are pressed. Shown while nothing is playing; the pressed keys sound once as the hand lands, no more. To let them hear a note or chord of the piece, use play_moment; to hear a stretch of it, play; to hear notes of your own, play_notes. fingers: [] gives the hand back to the score.",
    schema({
      hand: { type: "string", enum: ["right", "left"] },
      fingers: { type: "array", items: schema({ finger: { type: "integer", minimum: 1, maximum: 5 }, note: { type: "string", description: "Letter, accidental and octave, e.g. C4, F#3, Bb2." } }) },
      press: { type: "array", items: { type: "string" }, description: "The notes among those that are held down, usually the one just placed." },
    }),
  ),
  tool(
    "play_notes",
    "The hands on the screen play notes you write yourself, in the piece or not: a scale, a chord, an arpeggio, a tune, a bit of the piece changed to show a point. Sheet music of your own, not shown: for each hand that plays, its notes in order, and where the hand sits. Returns when played out, or when the learner says something. The hands stay where they end; place with fingers [] gives a hand back to the score.",
    schema(
      {
        tempo: { type: "integer", minimum: 30, maximum: 240, description: "Beats a minute." },
        hands,
        right: handPart,
        left: handPart,
      },
      ["tempo", "hands"],
    ),
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
  tool("listen", "Wait for the learner to say something (or, in a lesson, press Got it).", schema({})),
  tool("look", "The brief for some measures: where each hand sits and every moment it plays, with the fingering as it stands.", schema({ from_measure: measure("The first measure"), to_measure: measure("The last measure") })),
  tool(
    "change_fingering",
    "Change which finger plays a note at a moment, on the screen and in the brief. With everywhere, at every moment where that hand plays the same notes.",
    schema({ moment: { type: "string", description: "measure:beat" }, hand: { type: "string", enum: ["right", "left"] }, note: { type: "string", description: "e.g. C4" }, finger: { type: "integer", minimum: 1, maximum: 5 }, everywhere: { type: "boolean" } }),
  ),
  tool("move_note", "Give a note at a moment to the other hand.", schema({ moment: { type: "string", description: "measure:beat" }, note: { type: "string", description: "e.g. C4" }, hand: { type: "string", enum: ["right", "left"], description: "The hand to play it." } })),
  tool("see", "What is on the screen now: where they are, what each hand has there, whether it is playing, the tempo, the hands, the camera, the passage.", schema({})),
  tool(
    "screen",
    "Change the screen. Send only the fields that should change; the rest stay as they are. Answers what is on the screen afterwards.",
    optional({
      measure: measure("Go to the start of this measure"),
      moment: { type: "string", description: "Go to this moment (measure:beat) instead." },
      tempo: { type: "integer", minimum: 0, maximum: 240, description: "Beats a minute when playing; 0 for the score's own tempo." },
      hands,
      numbers: { type: "boolean", description: "Show the finger numbers over the keys." },
      sound: { type: "boolean", description: "Whether the piano is heard at all." },
      playing: { type: "boolean", description: "false stops the music. true starts it from where it is and does not wait for it; to play and wait, use play." },
      camera: optional({
        view: { type: "string", enum: Object.keys(VIEWS), description: "A named view: overhead (straight over the hands), player (from the seat), bass or treble (low, from that end)." },
        azimuth: { type: "number", minimum: -150, maximum: 150, description: "Degrees around the keyboard; 0 is straight on from the seat, positive swings to the player's right." },
        elevation: { type: "number", minimum: 6, maximum: 89, description: "Degrees above the keys." },
        zoom: { type: "number", minimum: 0.45, maximum: 2.8, description: "More is closer." },
        auto_cut: { type: "boolean", description: "Cut between the saved views as the piece plays." },
      }),
      passage: optional({
        from_measure: measure("The first measure Play keeps to"),
        to_measure: measure("The last measure Play keeps to"),
        times: { type: "integer", minimum: 0, maximum: 10, description: "How many times through; 0 for over and over." },
      }),
      whole_piece: { type: "boolean", description: "true gives Play the whole piece back: no passage." },
      look: optional(Object.fromEntries(Object.entries(LOOK_KINDS).map(([kind, names]) => [kind, { type: "string", enum: names }]))),
      reflexes: { type: "number", minimum: 0.5, maximum: 4, description: "How fast the hands move between chords; 1 is natural." },
    }),
  ),
  tool(
    "remember",
    "Rewrite one set of your notes in full: about the person (follows them everywhere) or about this workspace. Keep what still holds, add what you learnt, drop what is stale.",
    schema({ about: { type: "string", enum: ABOUT }, notes: { type: "string", description: `The whole set as it should now read, in short lines; up to ${MOST_NOTES} characters. "" to forget it all.` } }),
  ),
];

// Offered only while no lesson is on.
export const TEACH_TOOL = tool(
  "teach",
  "Begin a lesson on some measures: you become the teacher and lead it.",
  schema({
    from_measure: measure("The first measure to learn"),
    to_measure: measure("The last measure to learn"),
    style: { type: "string", enum: STYLES.map((style) => style.id), description: STYLES.map((style) => `${style.id}: ${style.blurb}`).join(" ") },
    said: { type: "string", description: "What they asked for, in their words." },
  }),
);

// Offered only while a lesson is on.
export const LESSON_TOOLS = [
  tool("focus", "Tell the screen which measures the lesson is on now.", schema({ from_measure: measure("The first measure"), to_measure: measure("The last measure") })),
  tool("done", "End the lesson.", schema({ closing: { type: "string", description: "A last word, spoken." } })),
];

export const ACTS = ["say", "pause", "place", "play_moment", "play", "play_notes"]; // the tools the screen performs

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
  // the workspace has open; screen(record) what is on the screen, as
  // projectScreen has it; patch(record, state, by) lays a change over the
  // workspace; notes.read(record) answers { person, workspace } and
  // notes.write(record, about, text) keeps one. `stale` is how long after
  // the model's last reply the conversation is dropped; `now` tells the time.
  constructor({ model, music, screen = null, patch, notes = null, stale = STALE_AFTER, now = Date.now }) {
    this.model = model;
    this.music = music;
    this.screen = screen;
    this.patch = patch;
    this.notes = notes ?? { read: async () => ({ person: "", workspace: "" }), write: async () => {} };
    this.stale = stale;
    this.now = now;
    this.sessions = new Map(); // workspace id → session
  }

  session(record) {
    return this.sessions.get(record.id) ?? null;
  }

  // The lesson under way, if the session has one.
  lesson(record) {
    return this.session(record)?.lesson ?? null;
  }

  // What a page needs to join the session under way.
  status(record) {
    const session = this.session(record);
    if (!session) return { on: false };
    return { on: true, lesson: session.lesson, status: session.status, ...(session.error ? { error: session.error } : {}), transcript: session.transcript, acts: [...session.pending.values()].map((entry) => entry.act) };
  }

  // The session for a workspace, begun if there was none: the agent arrives
  // where the learner is, with its notes, and nothing on the screen changes.
  async ensure(record) {
    const had = this.session(record);
    if (had) return had;
    const music = await this.music(record);
    if (!music.score.measures.length) throw new Error("The piece has no measures");
    const session = {
      id: record.id,
      record,
      score: record.state.score?.id ?? "",
      lesson: null, // the lesson under way, as the workspace holds it, or null
      teaching: null, // { style, brief } while a lesson is on
      notes: await this.notes.read(record),
      status: "listening",
      error: "",
      transcript: [],
      watchers: new Set(),
      inbox: [], // what the learner has said and the agent has not yet heard
      hearing: null, // resolves with the next thing the learner says
      pending: new Map(), // act id → { act, resolve }
      serial: 0,
      quiet: 0, // turns since the learner last said anything
      asked: null, // when the model last answered
      saidSince: [], // what has been put before the agent since the model was last asked
      pushUserLater: null, // words heard, to go into the conversation before the next call
      inTool: false, // a tool is being run (so the last message is the model's call, not its answer)
      ended: false,
      messages: [],
    };
    session.messages = [{ role: "system", content: await this.prompt(session) }];
    this.sessions.set(record.id, session);
    session.running = this.run(session).catch((error) => {
      console.error("MusicHands: the agent stopped.", error);
      this.end(session, "failed", { error: error.message });
    });
    return session;
  }

  // The system prompt as things stand: the notes, the brief for the measures
  // the learner is at, and the lesson if one is on.
  async prompt(session) {
    const { record } = session;
    const music = await this.music(record);
    const { measures } = music.score;
    const shot = await this.see(record);
    const found = measures.findIndex((entry) => shot.time < entry.start + entry.length - 1e-6);
    const around = lessonRange(defaultLesson(found < 0 ? measures.length - 1 : found, measures.length), measures);
    return agentPrompt({ score: music.score, tempo: music.tempo, brief: briefText(music, around), notes: session.notes, lesson: session.teaching });
  }

  async reprompt(session) {
    session.messages[0] = { role: "system", content: await this.prompt(session) };
  }

  // The tools the agent has right now.
  tools(session) {
    return session.lesson ? [...TOOLS, ...LESSON_TOOLS] : [...TOOLS, TEACH_TOOL];
  }

  // Begins a lesson. Throws when one is on, or the workspace has no music.
  async start(record, { from, to, style, said = "" } = {}) {
    if (this.lesson(record)) throw new Error("A lesson is already under way in this workspace");
    const lesson = cleanLesson({ mode: "teacher", from, to, style, score: record.state.score?.id ?? "" });
    if (!lesson) throw new Error("Say which measures: { from, to }, by index from 0");
    const session = await this.ensure(record);
    await this.beginLesson(session, lesson, String(said ?? "").trim().slice(0, 2000));
    return this.status(record);
  }

  // Lays the lesson over the session: the instructions, the tools, the
  // screen set for it, and the opening message, which the agent hears next.
  async beginLesson(session, lesson, words) {
    const music = await this.music(session.record);
    const range = lessonRange(lesson, music.score.measures);
    const style = findStyle(lesson.style);
    session.lesson = lesson;
    session.teaching = { style, brief: briefText(music, range) };
    await this.reprompt(session);
    // The screen is set for the lesson: the passage, seen from straight above.
    await this.lay(session, { lesson, passage: { from: lesson.from, to: lesson.to, times: 1, start: null, end: null }, time: range.start, playing: false, tempo: null, pose: NO_POSE, hands: stageHands("both"), camera: { view: { ...OVERHEAD }, autoCut: false } });
    if (words) this.tell(session, "said", { who: "learner", text: words });
    this.tell(session, "lesson", { on: true, lesson });
    this.deliver(session, openingMessage({ style, range, said: words }));
  }

  // Takes the lesson away again: the piece is put back, the instructions
  // and tools go, and the agent is told, in whatever it is waiting on.
  async endLesson(session, reason, { quietly = false } = {}) {
    if (!session.lesson) return false;
    session.lesson = null;
    session.teaching = null;
    await this.reprompt(session);
    if (reason !== "removed") await this.lay(session, NO_LESSON);
    this.tell(session, "lesson", { on: false, reason });
    if (quietly) return true;
    const note = `(The lesson is over: ${reason === "done" ? "you ended it" : "the learner stopped it"}. The piece is back as it was. You are simply there again; say nothing unless they speak.)`;
    // Idle between turns, the agent reads it when they next speak; otherwise it reaches it as their words would.
    if (session.hearing && !session.inTool) this.pushUser(session, note);
    else this.deliver(session, note, { cutting: "the lesson ended" });
    return true;
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

  // A change to the workspace, in the agent's name.
  lay(session, state) {
    return this.patch(session.record, state, session.lesson ? "teacher" : "agent");
  }

  // The learner says something: it reaches the agent in whatever it is
  // doing (see deliver). Begins the session if there was none.
  async say(record, text) {
    const words = String(text ?? "").trim().slice(0, 2000);
    if (!words) throw new Error("Say something: { text }");
    const had = this.session(record);
    const session = had ?? (await this.ensure(record));
    this.tell(session, "said", { who: "learner", text: words });
    this.deliver(session, words);
    return { heard: true, ...(had ? {} : { woke: true }) };
  }

  // Puts something before the agent. If it is listening, it hears it; if an
  // act is under way, the act is cut short with it (and the rest of the
  // turn's acts skipped); otherwise it waits to be heard before the next call.
  deliver(session, content, { cutting = "the learner spoke first" } = {}) {
    session.saidSince.push(content); // kept for a conversation begun afresh
    const pending = [...session.pending.values()];
    if (session.hearing) {
      const { resolve } = session.hearing;
      session.hearing = null;
      resolve(content);
    } else if (pending.length) {
      for (const [index, entry] of pending.entries()) {
        this.tell(session, "cut", { id: entry.act.id });
        session.pending.delete(entry.act.id);
        entry.resolve(index === 0 ? this.heard(session, { interrupted: true, learner_said: content }) : { skipped: true, reason: cutting });
      }
    } else session.inbox.push(content);
  }

  // The lead browser reports an act done.
  done(record, id, result = {}) {
    const session = this.session(record);
    if (!session) throw new Error("The agent is not here");
    const entry = session.pending.get(String(id));
    if (!entry) return { done: false }; // cut short already, or not this session's
    session.pending.delete(entry.act.id);
    entry.resolve(result && typeof result === "object" ? result : { done: true });
    return { done: true };
  }

  // After someone else has changed the workspace: another piece sends the
  // agent away; a lesson of its own taken out of the workspace (or replaced
  // by another kind) ends the lesson.
  settle(record) {
    const session = this.session(record);
    if (!session) return;
    if (record.state.score?.id !== session.score) {
      this.dismiss(record, "stopped").catch(() => {});
      return;
    }
    if (session.lesson && cleanLesson(record.state.lesson)?.mode !== "teacher") this.endLesson(session, "stopped").catch(() => {});
  }

  // Ends the lesson from outside (Stop, the page opened afresh). The agent stays.
  async stop(record, reason = "stopped") {
    const session = this.session(record);
    if (!session) return false;
    return this.endLesson(session, reason);
  }

  // Sends the agent away: the session and its conversation end (the notes stay).
  async dismiss(record, reason = "stopped") {
    const session = this.session(record);
    if (!session) return false;
    await this.end(session, reason);
    return true;
  }

  async end(session, reason, data = {}) {
    if (session.ended) return;
    session.ended = true;
    this.sessions.delete(session.id);
    for (const entry of session.pending.values()) entry.resolve({ skipped: true, reason: "the conversation ended" });
    session.pending.clear();
    if (session.hearing) session.hearing.resolve(null);
    session.status = reason;
    try {
      if (session.lesson && reason !== "removed") await this.lay(session, NO_LESSON);
    } finally {
      for (const response of session.watchers) send(response, "ended", { reason, ...data });
      session.watchers.clear();
    }
  }

  // Waits for the next thing put before the agent; null when the session
  // ends first. Said to be listening unless the status should stay as it is.
  hear(session, { quietly = false } = {}) {
    if (session.inbox.length) return Promise.resolve(session.inbox.shift());
    if (session.ended) return Promise.resolve(null);
    if (!quietly) this.tell(session, "status", { status: "listening" });
    return new Promise((resolve) => (session.hearing = { resolve }));
  }

  // Sends an act to the screen and waits for it to be done, cut short, or
  // given up. Something the learner has already said cuts it short at once.
  perform(session, act) {
    if (session.ended) return Promise.resolve({ skipped: true, reason: "the conversation ended" });
    if (session.inbox.length) return this.heard(session, { interrupted: true, reason: "the learner spoke before this began; answer them", learner_said: session.inbox.shift() });
    const id = String(++session.serial);
    const sent = { id, ...act };
    this.tell(session, "status", { status: act.type === "say" ? "speaking" : ["play", "play_moment", "play_notes"].includes(act.type) ? "playing" : "waiting", act: sent });
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

  // Adds the learner's words to the conversation; two of theirs in a row become one message.
  pushUser(session, content) {
    const last = session.messages.at(-1);
    if (last?.role === "user") last.content = `${last.content}\n\n${content}`;
    else session.messages.push({ role: "user", content });
  }

  // The conversation: wait for the learner, ask the model, do what it says,
  // tell it what happened, again. The agent begins by listening.
  async run(session) {
    for (;;) {
      if (session.ended) return;
      if (!session.pushUserLater && !session.inbox.length && session.messages.length === 1) {
        // Nothing before the agent yet: it listens for the first word.
        const words = await this.hear(session);
        if (words === null) return;
        session.pushUserLater = words;
      }
      if (this.isStale(session)) await this.refresh(session);
      if (session.pushUserLater) {
        this.pushUser(session, await this.learnerMessage(session, session.pushUserLater));
        session.pushUserLater = null;
        session.quiet = 0;
      }
      // Whatever else has been put before the agent and not yet heard goes in too.
      while (session.inbox.length) {
        this.pushUser(session, await this.learnerMessage(session, session.inbox.shift()));
        session.quiet = 0;
      }
      this.trim(session);
      this.tell(session, "status", { status: "thinking" });
      session.saidSince = [];
      let reply;
      try {
        reply = await this.model(session.messages, this.tools(session));
      } catch (error) {
        // Said on the panel; the next word from the learner (Got it will do) tries again.
        this.tell(session, "status", { status: "failed", error: error.message });
        const words = await this.hear(session, { quietly: true });
        if (words === null) return;
        session.pushUserLater = words;
        continue;
      }
      session.asked = this.now();
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
        session.pushUserLater = words;
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
        if (session.ended) outcome = { skipped: true, reason: "the conversation ended" };
        else if (heard !== null) {
          outcome = await this.heard(session, { skipped: true, reason: "the learner spoke while you were saying that; answer them", learner_said: heard });
          heard = null;
        } else if (cut) outcome = { skipped: true, reason: "the learner spoke first" };
        else {
          session.inTool = true;
          try {
            outcome = await this.runTool(session, name, parseArguments(call.function?.arguments));
          } catch (error) {
            outcome = { error: error.message };
          } finally {
            session.inTool = false;
          }
          if (outcome?.interrupted) cut = true;
        }
        if (name === "listen" || outcome?.interrupted) session.quiet = 0;
        results.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome ?? { done: true }) });
      }
      if (session.ended) return;
      session.messages.push(...results);
      if (session.quiet >= QUIET_TURNS) {
        // Going on and on without the learner: made to listen.
        const words = await this.hear(session);
        if (words === null) return;
        session.quiet = 0;
        session.pushUserLater = words;
      }
    }
  }

  // Would the next call find the conversation gone from the model's cache?
  isStale(session) {
    return session.asked !== null && session.messages.length > 1 && this.now() - session.asked > this.stale;
  }

  // Drops the conversation and starts another in its place: the system
  // prompt afresh, a word about what was lost, and what the learner has said since.
  async refresh(session) {
    const said = session.saidSince.splice(0);
    session.messages = [{ role: "system", content: await this.prompt(session) }];
    const lesson = session.lesson ? ` A lesson is under way (see THE LESSON); carry on with it from what they say.` : "";
    const since = said.length ? said.join("\n") : "Nothing has been said since; whatever you last asked of the screen has played out.";
    const line = await this.screenLine(session.record).catch(() => "");
    this.pushUser(session, `(This conversation is new: the one before was dropped while the learner was away a while. Your notes and the brief above are what you know.${lesson})\n${since}${line ? `\n(${line})` : ""}`);
    session.pushUserLater = null;
    session.inbox.length = 0;
    session.quiet = 0;
  }

  // A long conversation loses its oldest turns, whole: from after the system
  // prompt up to a message of the learner's.
  trim(session) {
    const { messages } = session;
    if (messages.length <= MOST_MESSAGES) return;
    let cut = messages.length - KEPT_MESSAGES;
    while (cut < messages.length && messages[cut].role !== "user") cut += 1;
    if (cut < messages.length) messages.splice(1, cut - 1);
  }

  // The learner's words as the model hears them: with what is on the screen as they speak.
  async learnerMessage(session, words) {
    const line = await this.screenLine(session.record).catch(() => "");
    return line ? `${words}\n(${line})` : words;
  }

  // A tool's answer that carries the learner's words, with the screen.
  async heard(session, outcome) {
    const line = await this.screenLine(session.record).catch(() => "");
    return line ? { ...outcome, screen: line } : outcome;
  }

  // One tool call, done here or on the screen. Answers what the model is told.
  async runTool(session, name, args) {
    const { record } = session;
    if (!this.tools(session).some((entry) => entry.function.name === name)) return { error: `No such tool now: ${name}` };
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
      case "play_notes": {
        const run = freehandSteps(args);
        if (run.error) return run;
        return this.perform(session, { type: "play_notes", ...run });
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
        return words === null ? { skipped: true, reason: "the conversation ended" } : this.heard(session, { said: words });
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
        await this.lay(session, { corrections: { fingers } });
        return this.fingeredNow(record, args.hand, momentName(event), { changed: moments.length });
      }
      case "move_note": {
        const music = await this.music(record);
        if (!["right", "left"].includes(args.hand)) return { error: "hand must be right or left" };
        const note = String(args.note ?? "");
        const other = args.hand === "right" ? "left" : "right";
        const event = this.findMoment(music, args.moment, other);
        if (!event || !event.notes.some((entry) => entry.note === note)) return { error: `The ${other} hand does not play ${note} at ${args.moment}` };
        await this.lay(session, { corrections: { hands: { [momentName(event)]: { [note]: args.hand } } } });
        return this.fingeredNow(record, args.hand, momentName(event), { moved: note });
      }
      case "see":
        return this.seen(record);
      case "screen":
        return this.changeScreen(session, args);
      case "remember": {
        if (!ABOUT.includes(args.about)) return { error: `about must be ${ABOUT.join(" or ")}` };
        const text = String(args.notes ?? "").trim().slice(0, MOST_NOTES);
        await this.notes.write(record, args.about, text);
        session.notes = { ...session.notes, [args.about]: text };
        return { kept: true, about: args.about, length: text.length };
      }
      case "teach": {
        const music = await this.music(record);
        const span = this.findMeasures(music, args.from_measure, args.to_measure);
        if (span.error) return span;
        const lesson = cleanLesson({ mode: "teacher", from: span.from, to: span.to, style: args.style, score: record.state.score?.id ?? "" });
        await this.beginLesson(session, lesson, String(args.said ?? "").trim().slice(0, 2000));
        const range = lessonRange(span, music.score.measures);
        return { lesson: `begun on measures ${range.from} to ${range.to} with "${findStyle(args.style).name}": see THE LESSON in your instructions, and the opening message that follows` };
      }
      case "focus": {
        const music = await this.music(record);
        const span = this.findMeasures(music, args.from_measure, args.to_measure);
        if (span.error) return span;
        session.lesson = { ...session.lesson, from: span.from, to: span.to };
        session.teaching = { ...session.teaching, brief: briefText(music, lessonRange(span, music.score.measures)) };
        await this.reprompt(session);
        await this.lay(session, { lesson: session.lesson, passage: { from: span.from, to: span.to, times: 1, start: null, end: null } });
        return { focus: `measures ${lessonRange(span, music.score.measures).from} to ${lessonRange(span, music.score.measures).to}`, brief: session.teaching.brief };
      }
      case "done": {
        const closing = String(args.closing ?? "").trim();
        if (closing) {
          this.tell(session, "said", { who: "teacher", text: closing });
          await this.perform(session, { type: "say", text: closing });
        }
        await this.endLesson(session, "done", { quietly: true });
        return { done: true, now: "the lesson is over and the piece is back as it was; you are simply there again. Say nothing more unless they speak: listen." };
      }
      default:
        return { error: `No such tool: ${name}` };
    }
  }

  // The screen tool: each field given is checked and laid on the workspace;
  // anything wrong is answered instead, and nothing changes.
  async changeScreen(session, args) {
    const { record } = session;
    const music = await this.music(record);
    const patch = {};
    if (args.moment !== undefined && args.moment !== "") {
      const event = this.findMoment(music, args.moment, "both");
      if (!event) return { error: `No moment ${args.moment} in the piece` };
      patch.time = event.time;
    } else if (args.measure !== undefined && args.measure !== "") {
      const span = this.findMeasures(music, args.measure, args.measure);
      if (span.error) return span;
      patch.time = music.score.measures[span.from].start;
    }
    if (args.tempo !== undefined) patch.tempo = Number(args.tempo) ? Math.min(240, Math.max(30, Math.round(Number(args.tempo)))) : null;
    if (HANDS.includes(args.hands)) patch.hands = stageHands(args.hands);
    for (const key of ["numbers", "sound", "playing"]) if (typeof args[key] === "boolean") patch[key] = args[key];
    if (args.camera && typeof args.camera === "object") {
      const named = VIEWS[args.camera.view];
      const view = { ...(named ?? {}) };
      for (const key of ["azimuth", "elevation", "zoom"]) if (Number.isFinite(args.camera[key])) view[key] = args.camera[key];
      patch.camera = { ...(Object.keys(view).length ? { view } : {}), ...(typeof args.camera.auto_cut === "boolean" ? { autoCut: args.camera.auto_cut } : {}) };
    }
    if (args.whole_piece === true) patch.passage = null;
    else if (args.passage && typeof args.passage === "object") {
      const span = this.findMeasures(music, args.passage.from_measure, args.passage.to_measure);
      if (span.error) return span;
      const times = Number(args.passage.times);
      patch.passage = { from: span.from, to: span.to, times: Number.isFinite(times) && times > 0 ? Math.min(10, Math.round(times)) : null, start: null, end: null };
    }
    if (args.look && typeof args.look === "object") {
      const look = {};
      for (const [kind, names] of Object.entries(LOOK_KINDS)) if (names.includes(args.look[kind])) look[kind] = args.look[kind];
      if (Object.keys(look).length) patch.look = look;
    }
    if (Number.isFinite(args.reflexes)) patch.reflexes = args.reflexes;
    if (!Object.keys(patch).length) return { error: "Nothing to change: send the fields that should change" };
    if (patch.time !== undefined || patch.hands) patch.pose = NO_POSE; // a posed hand goes back to the score when the piece moves on
    await this.lay(session, patch);
    return { changed: Object.keys(patch).filter((key) => key !== "pose"), ...(await this.seen(record)) };
  }

  // What is on the screen, as projectScreen has it (server.js hands it in).
  see(record) {
    if (!this.screen) throw new Error("the screen cannot be seen");
    return this.screen(record);
  }

  // What is on the screen, in a line: where they are, what each hand has,
  // whether it plays, which hands, the tempo, the passage.
  async screenLine(record) {
    const [shot, music] = await Promise.all([this.see(record), this.music(record)]);
    const { state } = record;
    const hand = (which) => (shot.hands[which].notes.length ? shot.hands[which].notes.map((note) => `${FINGER_SHORT[note.finger] ?? "?"} on ${note.note}${note.held ? " (held)" : ""}`).join(", ") : "nothing");
    const shown = state.hands.left.show && state.hands.right.show ? "both hands" : state.hands.left.show ? "left hand only" : state.hands.right.show ? "right hand only" : "no hands shown";
    const parts = [`measure ${shot.measure}, beat ${shot.beat}`, `right: ${hand("right")}`, `left: ${hand("left")}`, state.playing ? "playing" : "not playing", shown, `tempo ${state.tempo ?? music.tempo}`];
    if (state.passage) {
      const range = lessonRange(state.passage, music.score.measures);
      parts.push(`Play keeps to measures ${range.from} to ${range.to}${state.passage.times === null ? ", looped" : state.passage.times > 1 ? `, ${state.passage.times} times` : ""}`);
    }
    for (const which of ["right", "left"]) if (state.pose?.[which]) parts.push(`the ${which} hand is posed where you put it`);
    return `Screen: ${parts.join("; ")}`;
  }

  // The whole of it, for the see tool.
  async seen(record) {
    const { state } = record;
    const { view } = state.camera;
    const fingers = Object.values(state.corrections.fingers).reduce((count, hands) => count + Object.values(hands).reduce((inner, notes) => inner + Object.keys(notes).length, 0), 0);
    return {
      screen: await this.screenLine(record),
      camera: `azimuth ${view.azimuth}, elevation ${view.elevation}, zoom ${view.zoom}${state.camera.autoCut ? ", cutting between views as it plays" : ""}`,
      numbers: state.numbers ? "finger numbers shown" : "finger numbers hidden",
      sound: state.sound ? "sound on" : "sound off",
      look: Object.entries(state.look).map(([kind, name]) => `${kind} ${name}`).join(", "),
      corrections: `${fingers} finger ${fingers === 1 ? "correction" : "corrections"}, ${Object.keys(state.corrections.hands).length} notes moved to the other hand`,
    };
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
