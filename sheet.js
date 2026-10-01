// The sheet page is a projection of a workspace. Everything on the screen —
// the score, the moment shown, tempo, camera, which hands are drawn, every
// correction — comes from the workspace document on the server, and every
// click here is a change to that document. An agent with the workspace's
// connection string sees and changes the same things through the API.
import { assignFingering } from "./fingering.js";
import { noteToMidi } from "./hand-model.js";
import { applyHandMoves, countCorrections } from "./corrections.js";
import { applyChoices, HANDS } from "./hand-choices.js";
import { HandPlayer } from "./hand-player.js";
import { createHandView } from "./hand-view.js";
import { advanceLesson, defaultLesson, describeAdvance, describeNext, describeProgress, HEARD_ONCE, lessonRange, lessonSteps, OVERHEAD, phaseLines, phasePlays, slowTempo, stageHands } from "./lesson.js";
import { PianoAudio } from "./piano-audio.js";
import { LOOK_KINDS, LOOKS } from "./looks.js";
import { readMxl } from "./mxl.js";
import { parseScore } from "./score-model.js";
import { bandAt, stripHeight, stripScroll, systemBands } from "./score-strip.js";
import { ScoreTransport } from "./score-transport.js";
import { Narrator, serverSpeech } from "./speech.js";
import { homeWorkspace, keepHomeWorkspace, WorkspaceClient, workspaceFromHash } from "./workspace-client.js";
import { LIMITS } from "./workspace-model.js";

const songList = document.querySelector("#song-list");
const scoreFile = document.querySelector("#score-file");
const scoreTitle = document.querySelector("#score-title");
const removeScore = document.querySelector("#remove-score");
const dialogs = { song: document.querySelector("#song-dialog"), settings: document.querySelector("#settings-dialog"), lesson: document.querySelector("#lesson-dialog") };
const scoreContainer = document.querySelector("#score-container");
const status = document.querySelector("#sheet-status");
const statusText = document.querySelector("#sheet-status-text");
const handsStage = document.querySelector("#hands-stage");
const numbersToggle = document.querySelector("#numbers-toggle");
const qualitySelect = document.querySelector("#quality-select");
const lookFields = document.querySelector("#look-fields");
const DEFAULT_TEMPO = 120; // quarter notes a minute, for scores that do not state one
const dropHint = document.querySelector("#drop-hint");
const fullScreenButton = document.querySelector("#full-screen");
const playScore = document.querySelector("#play-score");
const tempoSlider = document.querySelector("#tempo");
const tempoOutput = document.querySelector("#tempo-output");
const tempoTicks = document.querySelector("#tempo-ticks");
const handChoice = document.querySelector(".hand-choice");
const learnButton = document.querySelector("#learn");
const lessonPanel = {
  root: document.querySelector("#lesson"),
  kicker: document.querySelector("#lesson-kicker"),
  progress: document.querySelector("#lesson-progress"),
  caption: document.querySelector("#lesson-caption"),
  next: document.querySelector("#lesson-next"),
  stop: document.querySelector("#lesson-stop"),
  play: document.querySelector("#lesson-play"),
  restart: document.querySelector("#lesson-restart"),
  again: document.querySelector("#lesson-again"),
};
const lessonFrom = document.querySelector("#lesson-from");
const lessonTo = document.querySelector("#lesson-to");
const bar = {
  connect: document.querySelector("#workspace-connect"),
  home: document.querySelector("#workspace-home"),
  status: document.querySelector("#workspace-status"),
  statusText: document.querySelector("#workspace-status-text"),
  string: document.querySelector("#workspace-string"),
};

// What the page has worked out from the workspace: the score as read, its
// fingering, and the transient things only this browser knows (which keys the
// pointer holds, what a replay is sounding).
const page = {
  score: null,
  xml: null,
  events: [],
  steps: [],
  positions: { right: [], left: [] },
  stepIndex: 0,
  osmd: null,
  showGuides: true,
  clicked: new Set(), // keys held down by the pointer
  replay: null, // notes the play buttons are holding, or null
  tempo: DEFAULT_TEMPO, // quarter notes a minute, as the transport uses it
  cursorAt: null, // the score time the notation cursor was last moved to
  fullScreen: false, // the piano fills the window, under the line of music being played
  bands: null, // where each line of music sits in the notation as drawn; worked out when asked for
  measureShown: null, // the measure the hands were last shown in
  poseArrived: false, // a told pose has just changed, so its pressed keys are struck
  notes: [],
  doubts: [],
};
// The workspace as it is on the screen, so only what changed is redrawn.
let shown = {};
let ws = null; // the open WorkspaceClient

const handsView = await createHandView(handsStage, {
  interactive: true,
  autoCut: true,
  qualitySelect,
  onCamera: (camera) => ws?.change({ camera }),
});
const audio = new PianoAudio({ enabled: true });

function setStatus(message, stateName = "idle") {
  statusText.textContent = message;
  status.dataset.state = stateName;
}

function setWorkspaceStatus(message, stateName = "connected") {
  bar.statusText.textContent = message;
  bar.status.dataset.state = stateName;
}

// ---------------------------------------------------------------------------
// Reading the score

// Steps are the distinct moments a hand attacks something; both hands share one timeline.
function buildSteps(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.time)) groups.set(event.time, []);
    groups.get(event.time).push(event);
  }
  return [...groups].filter(([, group]) => group.some((event) => event.attack))
    .sort(([a], [b]) => a - b)
    .map(([time, group]) => ({ time, events: group, measure: group[0].measure, beat: group[0].beat }));
}

// The step the workspace's time lands on: the last one at or before it.
function stepIndexAt(time) {
  let low = 0;
  let high = page.steps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (page.steps[middle].time <= time + 1e-6) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function positionAt(hand, time) {
  const list = page.positions[hand];
  let found = null;
  for (const position of list) {
    if (position.startTime <= time) found = position;
    else break;
  }
  return found;
}

function eventAt(hand, time) {
  let found = null;
  for (const event of page.events) {
    if (event.hand !== hand) continue;
    if (event.time <= time) found = event;
    else break;
  }
  return found;
}

// What each hand is doing at a step: where it sits, which notes it holds
// down, and which of those it strikes at that very moment. A note tied over
// from before is held down but not struck.
function momentAt(step) {
  if (step.moment) return step.moment;
  const moment = {};
  ["right", "left"].forEach((hand) => {
    const position = positionAt(hand, step.time);
    const event = eventAt(hand, step.time);
    if (!position) return;
    const current = event && event.time + event.duration > step.time;
    const sounding = current ? event.notes.map((note) => note.midi) : [];
    const struck = current && event.time === step.time ? event.notes.filter((note) => !note.held) : [];
    moment[hand] = { position, event, sounding, struck, striking: struck.length > 0 };
  });
  return moment;
}

// Works the fingering out again from the score and the workspace's corrections.
function refinger(corrections) {
  const moved = applyHandMoves(page.score.events, corrections.hands);
  const fingered = assignFingering(moved, { overrides: corrections.fingers });
  page.events = fingered.events;
  page.positions = fingered.positions;
  page.steps = buildSteps(page.events);
  // Build once in score order. Playback used to rescan the complete score and
  // position lists several times per note, making long pieces progressively slow.
  for (const hand of HANDS) {
    const events = page.events.filter((event) => event.hand === hand);
    const positions = page.positions[hand];
    let eventIndex = -1;
    let positionIndex = -1;
    for (const step of page.steps) {
      while (eventIndex + 1 < events.length && events[eventIndex + 1].time <= step.time) eventIndex++;
      while (positionIndex + 1 < positions.length && positions[positionIndex + 1].startTime <= step.time) positionIndex++;
      step.moment ??= {};
      const position = positions[positionIndex];
      if (!position) continue;
      const event = events[eventIndex];
      const current = event && event.time + event.duration > step.time;
      const struck = current && event.time === step.time ? event.notes.filter((note) => !note.held) : [];
      step.moment[hand] = { position, event, sounding: current ? event.notes.map((note) => note.midi) : [], struck, striking: struck.length > 0 };
    }
  }
}

// Fetches and reads one of the workspace's scores. Returns false if it cannot.
async function loadScore(score) {
  stopTransport();
  if (!score) {
    page.score = null;
    page.xml = null;
    scoreTitle.textContent = "No score yet";
    document.title = "MusicHands — Sheet Music";
    scoreContainer.replaceChildren();
    setStatus("Import a score to begin", "idle");
    return false;
  }
  const label = score.title || "the score";
  setStatus(`Reading ${label}`, "idle");
  let xml;
  try {
    xml = await ws.readScore(score.id);
    page.score = parseScore(xml);
  } catch (error) {
    page.score = null;
    setStatus(`Could not read ${label}: ${error.message}`, "outside");
    return false;
  }
  page.xml = xml;
  page.notes = [];
  page.doubts = [];
  page.measureShown = null;
  scoreTitle.textContent = page.score.title;
  document.title = `MusicHands — ${page.score.title}`;
  try {
    await renderNotation(xml);
  } catch (error) {
    scoreContainer.innerHTML = `<p class="score-fallback">The notation could not be drawn: ${error.message}</p>`;
  }
  return true;
}

function showSummary() {
  const corrections = ws?.state?.corrections ?? { fingers: {}, hands: {} };
  const guessed = page.events.filter((event) => event.fingeringSource === "heuristic").length;
  const corrected = countCorrections(corrections.fingers) + Object.values(corrections.hands).reduce((sum, notes) => sum + Object.keys(notes).length, 0);
  const summary = guessed
    ? `${page.score.measures.length} measures · ${page.positions.right.length + page.positions.left.length} hand positions · ${guessed} of ${page.events.length} moments use guessed fingering`
    : `${page.score.measures.length} measures · ${page.positions.right.length + page.positions.left.length} hand positions · fingering fully authored`;
  const parts = [summary, ...(corrected ? [`${corrected} ${corrected === 1 ? "correction" : "corrections"}`] : []), ...page.notes, ...page.doubts];
  setStatus(parts.join(" · "), page.doubts.length ? "outside" : "connected");
}

// ---------------------------------------------------------------------------
// Drawing the hands

// Puts the hands on the stage for the current step. The play buttons and the
// pointer can both press keys on top of what the score holds down. Returns the
// milliseconds until struck keys land.
function showHands({ jump = false, strike = true, landIn = null } = {}) {
  const step = page.steps[page.stepIndex];
  if (!step || !ws?.state) return 0;
  const moment = momentAt(step);
  const { shown: drawn } = applyChoices(moment, ws.state.hands);
  const hands = { left: null, right: null };
  const underFinger = new Set();
  for (const hand of drawn) {
    const { position, sounding, struck, striking } = moment[hand];
    const assigned = new Set(position.fingers.map((entry) => noteToMidi(entry.note)));
    assigned.forEach((midi) => underFinger.add(midi));
    const held = page.replay ? [...page.replay] : sounding;
    const active = [...new Set([...held, ...page.clicked])].filter((midi) => assigned.has(midi));
    hands[hand] = {
      fingers: position.fingers,
      activeMidis: active,
      strike: strike && (page.replay ? active.length > 0 : striking),
      // Replaying a moment strikes everything in it; the score strikes only what is not tied over.
      strikeMidis: page.replay ? null : struck.map((note) => note.midi),
    };
  }
  // A hand the workspace puts somewhere itself goes there instead, while the
  // piece is not playing; its pressed keys are struck as the pose arrives.
  if (!transport.playing) {
    for (const hand of HANDS) {
      const pose = ws.state.pose[hand];
      if (!pose || !ws.state.hands[hand].show) continue;
      const pressed = pose.press.map(noteToMidi);
      pose.fingers.forEach((entry) => underFinger.add(noteToMidi(entry.note)));
      hands[hand] = { fingers: pose.fingers, activeMidis: pressed, strike: strike && page.poseArrived && pressed.length > 0, strikeMidis: pressed };
    }
  }
  const landing = handsView.setHands(hands, { immediate: jump, landIn });
  // Keys with no hand on them: clicked ones, and replayed ones. A hidden hand
  // leaves its keys alone, even when it is still heard.
  const hidden = new Set(HANDS.filter((hand) => moment[hand] && !drawn.includes(hand)).flatMap((hand) => moment[hand].sounding));
  const loose = [...page.clicked, ...(page.replay ?? [])].filter((midi) => !underFinger.has(midi) && !hidden.has(midi));
  const struckLoose = strike && !jump && page.replay ? loose.filter((midi) => page.replay.has(midi)) : [];
  handsView.setSounding(loose, { struck: struckLoose, delay: landIn ?? landing });
  return landing;
}

// The stage can solve these poses before the transport reaches them. Pointer
// notes and replay state are intentionally left out; score playback is the hot
// path and those interactive changes are not predictable.
function scoreHandSpecs() {
  if (!ws?.state) return [];
  return page.steps.map((step) => {
    const moment = momentAt(step);
    const { shown: drawn } = applyChoices(moment, ws.state.hands);
    const hands = { left: null, right: null };
    for (const hand of drawn) {
      const { position, sounding, struck, striking } = moment[hand];
      const assigned = new Set(position.fingers.map((entry) => noteToMidi(entry.note)));
      hands[hand] = {
        fingers: position.fingers,
        activeMidis: sounding.filter((midi) => assigned.has(midi)),
        strike: striking,
        strikeMidis: struck.map((note) => note.midi),
      };
    }
    return hands;
  });
}

// landIn is set while the score is playing: the notes must land that many
// milliseconds from now, on their beat.
function renderHands({ jump = false, sound = false, landIn = null } = {}) {
  const step = page.steps[page.stepIndex];
  if (!step) return;
  player.stop();
  if (!jump) handsView.beat({ measureStarted: step.measure !== page.measureShown });
  page.measureShown = step.measure;
  const landing = showHands({ jump, landIn });
  if (sound) soundMoment(page.stepIndex, landIn ?? landing, landIn !== null);
  if (landIn !== null) queueCursor();
}

function soundMoment(index, delay, playing = true) {
  const moment = momentAt(page.steps[index]);
  if (!playing) {
    const struck = new Set(Object.values(moment).flatMap((entry) => entry.struck.map((note) => note.midi)));
    audio.releaseAll({ except: Object.values(moment).flatMap((entry) => entry.sounding.filter((midi) => !struck.has(midi))) });
  }
  for (const note of applyChoices(moment, ws.state.hands).heard) {
    const written = (note.sustain * 60000) / page.tempo;
    const duration = playing ? Math.max(40, written) : Math.min(6000, Math.max(1200, written));
    audio.noteOn(note.midi, { delay, duration });
  }
}

// While the score plays, the notation cursor follows a little behind the
// hands, so a fast passage does not redraw it on every note.
let cursorTimer = null;
function queueCursor() {
  if (cursorTimer !== null) return;
  cursorTimer = setTimeout(() => {
    cursorTimer = null;
    moveCursorTo(page.steps[page.stepIndex].time);
  }, 100);
}

// `jump` puts the notation where it belongs at once instead of gliding there.
function moveCursorTo(time, { jump = false } = {}) {
  const { osmd } = page;
  if (!osmd?.cursor) return;
  const cursor = osmd.cursor;
  // next() redraws the cursor image, including canvas.toDataURL(). Hide it
  // while advancing so a seek or coalesced frame paints only its destination.
  cursor.hide();
  // OSMD measures time in whole notes; the model uses quarter notes.
  const target = time / 4 - 1e-6;
  // Going forward carries on from where the cursor is; going back starts over.
  if (page.cursorAt === null || time < page.cursorAt) cursor.reset();
  page.cursorAt = time;
  let guard = 0;
  while (!cursor.iterator.EndReached && cursor.iterator.currentTimeStamp.RealValue < target && guard < 5000) {
    cursor.next();
    guard += 1;
  }
  cursor.show();
  const cursorElement = cursor.cursorElement;
  if (!cursorElement) return;
  showLineAt(cursorElement, jump);
}

// Moving through the score by hand is a change to the workspace's time; the
// hands follow when the change comes back through apply().
function goToStep(index) {
  const step = page.steps[Math.max(0, Math.min(page.steps.length - 1, index))];
  if (!step) return;
  ws.change({ time: step.time, playing: false });
}

// The first step at or after a time, as when a measure is clicked.
function goToTime(time) {
  const index = page.steps.findIndex((step) => step.time >= time - 1e-6);
  goToStep(index === -1 ? page.steps.length - 1 : index);
}

// ---------------------------------------------------------------------------
// The notation

async function renderNotation(xmlText) {
  if (!window.opensheetmusicdisplay) {
    scoreContainer.innerHTML = `<p class="score-fallback">The notation renderer could not be loaded. The hand positions below still work.</p>`;
    return;
  }
  if (!page.osmd) {
    page.osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(scoreContainer, {
      autoResize: true,
      drawTitle: false,
      drawComposer: false,
      drawLyricist: false,
      drawPartNames: false,
      followCursor: false,
      cursorsOptions: [{ type: 0, color: "#b8683e", alpha: 0.35, follow: false }],
    });
    // OSMD re-renders itself on resize by calling render() on the instance, and
    // each render rebuilds the SVG, so wrap it to put the guides back every time.
    const render = page.osmd.render.bind(page.osmd);
    page.osmd.render = () => {
      render();
      page.cursorAt = null;
      page.bands = null;
      drawStaffGuides();
      showScoreStrip();
    };
  }
  await page.osmd.load(xmlText);
  page.cursorAt = null;
  page.osmd.render();
  page.osmd.cursor.show();
}

// Staff-line colours keyed by letter name, so a pitch wears the same colour on
// both staves: treble lines E G B D F, bass lines G B D F A, and the two ledger
// guides under the treble staff for middle C and the A below it.
const LINE_COLORS = {
  C: "#c8423a",
  D: "#dc7d2b",
  E: "#b39a14",
  F: "#3f9a4f",
  G: "#2a97a3",
  A: "#3c6fd0",
  B: "#8a4fc2",
};
const STAFF_LETTERS = { treble: ["F", "D", "B", "G", "E"], bass: ["A", "F", "D", "B", "G"] }; // top line first
// Faint ledger guides below each staff, as offsets from the top line.
const LEDGER_GUIDES = {
  treble: [
    { letter: "C", offset: 5 }, // middle C
    { letter: "A", offset: 6 },
  ],
  bass: [
    { letter: "E", offset: 5 },
    { letter: "C", offset: 6 },
  ],
};
const SVG_NS = "http://www.w3.org/2000/svg";

function drawStaffGuides() {
  const { osmd } = page;
  const svg = scoreContainer.querySelector("svg");
  if (!svg) return;
  svg.querySelector(".staff-guides")?.remove();
  if (!osmd?.GraphicSheet || !page.showGuides) return;

  // OSMD lays out in staff-space units; the SVG uses 10 px per unit at zoom 1.
  const unit = 10 * (osmd.zoom ?? 1);
  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", "staff-guides");
  layer.setAttribute("pointer-events", "none");

  const addLine = (x, y, width, letter, faint) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", (x * unit).toFixed(1));
    line.setAttribute("x2", ((x + width) * unit).toFixed(1));
    line.setAttribute("y1", (y * unit).toFixed(1));
    line.setAttribute("y2", (y * unit).toFixed(1));
    line.setAttribute("stroke", LINE_COLORS[letter]);
    line.setAttribute("stroke-width", faint ? unit * 0.1 : unit * 0.15);
    if (faint) line.setAttribute("stroke-opacity", "0.4");
    line.dataset.letter = letter;
    layer.append(line);
  };

  for (const musicPage of osmd.GraphicSheet.MusicPages) {
    for (const system of musicPage.MusicSystems) {
      for (const staffLine of system.StaffLines) {
        const { AbsolutePosition: pos, Size: size } = staffLine.PositionAndShape;
        const clef = staffLine.Measures?.[0]?.InitiallyActiveClef?.ClefType;
        // ClefType 0 is G (treble), 1 is F (bass). Fall back to staff order.
        const isTreble = clef === undefined ? staffLine.ParentStaff?.idInMusicSheet === 0 : clef === 0;
        const kind = isTreble ? "treble" : "bass";
        STAFF_LETTERS[kind].forEach((letter, index) => addLine(pos.x, pos.y + index, size.width, letter, false));
        for (const guide of LEDGER_GUIDES[kind]) {
          addLine(pos.x, pos.y + guide.offset, size.width, guide.letter, true);
        }
      }
    }
  }
  svg.append(layer);
}

function renderLegend() {
  const legend = document.getElementById("staff-legend");
  if (!legend) return;
  legend.innerHTML = "";
  for (const [letter, color] of Object.entries(LINE_COLORS)) {
    const chip = document.createElement("span");
    chip.className = "legend-chip";
    chip.style.setProperty("--chip", color);
    chip.textContent = letter;
    legend.append(chip);
  }
}

// How many pixels on the screen one of OSMD's layout units (a staff space) takes.
function notationUnit(svg) {
  const width = svg.getBoundingClientRect().width;
  return 10 * (page.osmd.zoom ?? 1) * (width / Number(svg.getAttribute("width") || width));
}

// Clicking a measure in the notation jumps the hands to that measure. The
// listener sits on the container because OSMD replaces its SVG on every render.
function measureAtPoint(clientX, clientY) {
  const { osmd } = page;
  const svg = scoreContainer.querySelector("svg");
  if (!osmd?.GraphicSheet || !svg) return null;
  const rect = svg.getBoundingClientRect();
  const unit = notationUnit(svg);
  const x = (clientX - rect.left) / unit;
  const y = (clientY - rect.top) / unit;
  for (const measureRow of osmd.GraphicSheet.MeasureList) {
    // Each row holds one box per staff; treat the whole grand-staff column as one target.
    const boxes = measureRow.filter(Boolean).map((measure) => measure.PositionAndShape);
    if (!boxes.length) continue;
    const left = Math.min(...boxes.map((box) => box.AbsolutePosition.x));
    const right = Math.max(...boxes.map((box) => box.AbsolutePosition.x + box.Size.width));
    const top = Math.min(...boxes.map((box) => box.AbsolutePosition.y)) - 3;
    const bottom = Math.max(...boxes.map((box) => box.AbsolutePosition.y + Math.max(box.Size.height, 4))) + 3;
    if (x >= left && x <= right && y >= top && y <= bottom) {
      const measure = measureRow.find(Boolean);
      return measure.parentSourceMeasure?.measureListIndex ?? measure.MeasureNumber - 1;
    }
  }
  return null;
}

scoreContainer.addEventListener("click", (event) => {
  const index = measureAtPoint(event.clientX, event.clientY);
  if (index === null) return;
  const measure = page.score?.measures[index];
  if (measure) goToTime(measure.start);
});

// ---------------------------------------------------------------------------
// The strip of notation over the piano, and full screen

// Where each line of music sits in the notation as it is drawn now.
function notationBands() {
  if (page.bands) return page.bands;
  const svg = scoreContainer.querySelector("svg");
  if (!page.osmd?.GraphicSheet || !svg) return [];
  const unit = notationUnit(svg);
  const systems = page.osmd.GraphicSheet.MusicPages.flatMap((musicPage) => musicPage.MusicSystems).map((system) => {
    const tops = system.StaffLines.map((staffLine) => staffLine.PositionAndShape.AbsolutePosition.y);
    // A staff is four spaces tall.
    return { top: Math.min(...tops) * unit, bottom: (Math.max(...tops) + 4) * unit };
  });
  page.bands = systemBands(systems, svg.getBoundingClientRect().height);
  return page.bands;
}

// Scrolls the strip of notation to the line the cursor is on.
function showLineAt(cursorElement, jump) {
  const svg = scoreContainer.querySelector("svg");
  const bands = notationBands();
  if (!svg || !bands.length) return;
  const drawing = svg.getBoundingClientRect();
  const box = cursorElement.getBoundingClientRect();
  const band = bands[bandAt(bands, box.top + box.height / 2 - drawing.top)];
  // The drawing may not start right at the top of what the strip scrolls.
  const offset = drawing.top - scoreContainer.getBoundingClientRect().top + scoreContainer.scrollTop;
  const top = Math.round(offset + stripScroll(band, scoreContainer.clientHeight));
  if (Math.abs(top - scoreContainer.scrollTop) > 1) scoreContainer.scrollTo({ top, behavior: jump ? "instant" : "smooth" });
}

// Makes the strip one line of music tall, and shows the line being played.
function showScoreStrip() {
  const bands = notationBands();
  if (!bands.length) return;
  // The piano keeps most of the window however tall a line of music is.
  document.body.style.setProperty("--score-strip", `${Math.ceil(stripHeight(bands, window.innerHeight * 0.45))}px`);
  // A glide started while the window is still changing size is cut short, so go straight there.
  if (page.steps.length) moveCursorTo(page.steps[page.stepIndex]?.time ?? 0, { jump: true });
}

function setFullScreen(on) {
  if (on === page.fullScreen) return;
  page.fullScreen = on;
  document.body.classList.toggle("full-screen", on);
  fullScreenButton.textContent = on ? "Exit full screen" : "Full screen";
  fullScreenButton.setAttribute("aria-pressed", String(on));
  // Where the browser will not hand over the whole screen, the page still fills its window.
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  // The notation is a different width now, so its lines break in new places.
  if (page.score && page.osmd?.GraphicSheet) page.osmd.render();
}

fullScreenButton.addEventListener("click", () => setFullScreen(!page.fullScreen));

// ---------------------------------------------------------------------------
// The look: the piano, the player and the place, chosen in settings

const LOOK_LABELS = { piano: "Piano", build: "Player", skin: "Skin", outfit: "Clothes", gloves: "Gloves", scene: "Place" };
const lookSelects = {};
for (const kind of LOOK_KINDS) {
  const field = document.createElement("label");
  field.className = "field field--inline";
  const name = document.createElement("span");
  name.textContent = LOOK_LABELS[kind] ?? kind;
  const select = document.createElement("select");
  select.setAttribute("aria-label", LOOK_LABELS[kind] ?? kind);
  for (const [value, spec] of Object.entries(LOOKS[kind])) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = spec.label;
    select.append(option);
  }
  select.addEventListener("change", () => ws.change({ look: { [kind]: select.value } }));
  field.append(name, select);
  lookFields.append(field);
  lookSelects[kind] = select;
}

function showLook(look) {
  for (const kind of LOOK_KINDS) lookSelects[kind].value = look[kind];
  handsView.setLook(look);
}
// Escape, or the browser's own way out of full screen, leaves this one too.
// Going in, the window has only now reached its full size.
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) setFullScreen(false);
  else if (page.fullScreen) showScoreStrip();
});

// ---------------------------------------------------------------------------
// Scores: the workspace's own

// Lists the workspace's songs in the song dialog and marks the one that is open.
function showScores() {
  const open = ws?.state?.score;
  songList.replaceChildren(
    ...(ws?.scores ?? []).map((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "song-list__item";
      item.setAttribute("role", "listitem");
      item.setAttribute("aria-current", String(entry.id === open?.id));
      item.innerHTML = `<strong></strong><span></span>`;
      item.querySelector("strong").textContent = entry.title;
      item.querySelector("span").textContent = entry.measures ? `${entry.measures} measures` : "";
      item.addEventListener("click", () => {
        if (entry.id !== open?.id) chooseScore(entry);
        dialogs.song.close();
      });
      return item;
    }),
  );
  removeScore.hidden = !open;
}

// Points the workspace at another of its pieces. Corrections are by moment,
// so they stay behind with the piece they were made for.
function chooseScore({ id, title }) {
  ws.change({ score: { id, title }, time: 0, playing: false, corrections: { fingers: null, hands: null }, lesson: null, pose: { left: null, right: null } });
}

scoreTitle.addEventListener("click", () => dialogs.song.showModal());
document.querySelector("#settings-open").addEventListener("click", () => dialogs.settings.showModal());

// Turns a PDF of a score into MusicXML. The reader is only fetched when needed.
async function readPdfScore(file) {
  const [{ readPdf }, { pdfToMusicXml }] = await Promise.all([import("./pdf-reader.js"), import("./pdf-score.js")]);
  const pages = await readPdf(await file.arrayBuffer(), {
    onPage: (done, total) => setStatus(`Reading ${file.name}: page ${done} of ${total}`, "idle"),
  });
  const read = pdfToMusicXml(pages);
  return { xml: read.xml, notes: ["read from a PDF"], doubts: read.warnings };
}

async function importScoreFile(file) {
  // What the reader makes of the file is told in the song dialog.
  if (!dialogs.song.open) dialogs.song.showModal();
  setStatus(`Reading ${file.name}`, "idle");
  try {
    let xml;
    let notes = [];
    let doubts = [];
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") ({ xml, notes, doubts } = await readPdfScore(file));
    else if (/\.mxl$/i.test(file.name)) xml = await readMxl(await file.arrayBuffer());
    else if (/\.(musicxml|xml)$/i.test(file.name)) xml = await file.text();
    else throw new Error("it is not a PDF, MusicXML or MXL file");
    const title = parseScore(xml).title;
    const named = title && title !== "Untitled" ? title : file.name.replace(/\.[^.]+$/, "");
    setStatus(`Adding ${named} to your workspace`, "idle");
    const added = await ws.addScore(xml, named);
    // What the reader had to guess at is worth saying once the piece is up.
    pendingImportNotes = { id: added.id, notes, doubts };
    chooseScore(added);
    dialogs.song.close();
  } catch (error) {
    setStatus(`Could not import ${file.name}: ${error.message}`, "outside");
  }
}
let pendingImportNotes = null;

scoreFile.addEventListener("change", () => {
  const [file] = scoreFile.files;
  if (file) importScoreFile(file);
  scoreFile.value = "";
});

removeScore.addEventListener("click", async () => {
  const entry = ws?.scores.find((known) => known.id === ws?.state?.score?.id);
  if (!entry || !window.confirm(`Remove “${entry.title}” from your workspace?`)) return;
  try {
    await ws.removeScore(entry.id);
  } catch (error) {
    setStatus(`Could not remove ${entry.title}: ${error.message}`, "outside");
  }
});

// A score can also be dropped anywhere on the page.
let dragDepth = 0;
const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (event) => {
  if (!carriesFiles(event)) return;
  dragDepth += 1;
  dropHint.hidden = false;
});
window.addEventListener("dragleave", (event) => {
  if (!carriesFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropHint.hidden = true;
});
window.addEventListener("dragover", (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
window.addEventListener("drop", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropHint.hidden = true;
  const [file] = event.dataTransfer.files;
  if (file) importScoreFile(file);
});

// ---------------------------------------------------------------------------
// Sound: replaying a moment, and playing the piece through

// The play buttons replay the notes of the current moment, with the fingers
// that hold them, either as written or one at a time from the bottom up.
const player = new HandPlayer({
  audio,
  press: (midis) => {
    page.replay = new Set(midis);
    return showHands();
  },
  release: () => {
    page.replay = null;
    showHands({ strike: false });
  },
  onChange: () => {},
});

function replay(mode) {
  const step = page.steps[page.stepIndex];
  if (!step) return;
  if (transport.playing) {
    stopTransport();
    ws.change({ playing: false });
  }
  if (player.mode === mode) {
    player.stop();
    return;
  }
  // Only the hands that are switched on for sound are replayed.
  const moment = momentAt(step);
  const notes = HANDS.filter((hand) => moment[hand] && ws.state.hands[hand].sound).flatMap((hand) => moment[hand].sounding);
  // Lift everything first so the fingers strike afresh.
  page.replay = new Set();
  showHands({ strike: false });
  audio.releaseAll();
  player.play(notes, mode);
}


// Playing the score through. The browser leading the workspace runs the
// transport and writes each step's time back, so every other browser and
// every agent sees the music move.
let lastSharedTime = -Infinity;
const transport = new ScoreTransport({
  steps: () => page.steps,
  tempo: () => page.tempo,
  reach: () => handsView.reach,
  perform: (index, landIn) => {
    page.stepIndex = index;
    shown.stepIndex = index;
    renderHands({ landIn });
    const now = performance.now();
    if (now - lastSharedTime >= 100 || index === page.steps.length - 1) {
      lastSharedTime = now;
      ws.change({ time: page.steps[index].time });
    }
  },
  schedule: (index, delay) => soundMoment(index, delay),
  cancelScheduled: () => audio.cancelScheduled(),
  tail: (index) => Math.max(...page.steps[index].events.flatMap((event) => event.notes.map((note) => (note.sustain * 60000) / page.tempo))),
  done: () => {
    showPlaying(false);
    ws.change({ playing: false });
    if (ws.state?.lesson?.phase === "once") voice.say(HEARD_ONCE);
  },
});

function showPlaying(playing) {
  playScore.textContent = playing ? (preparingTransport ? "■ Preparing…" : "■ Stop") : "▶ Play";
  playScore.classList.toggle("is-playing", playing);
  handsView.setRolling(playing);
}

let preparingTransport = null;
let preparationSerial = 0;
async function startTransport() {
  if (transport.playing || preparingTransport || !page.steps.length) return;
  player.stop();
  // Finish any remaining pose work before starting the clock. A short pause
  // here is preferable to losing time repeatedly inside a fast passage.
  const client = ws;
  const steps = page.steps;
  const serial = ++preparationSerial;
  const preparation = Promise.all([handsView.prepareHands(scoreHandSpecs(), { urgent: true }), audio.prepare()]);
  preparingTransport = preparation;
  let prepared;
  try {
    [prepared] = await preparation;
  } catch (error) {
    if (ws === client && serial === preparationSerial) {
      setStatus(`Could not prepare playback: ${error.message}`, "outside");
      client.change({ playing: false });
    }
    return;
  } finally {
    if (preparingTransport === preparation) preparingTransport = null;
  }
  if (serial !== preparationSerial || !prepared || ws !== client || page.steps !== steps || !client.lead || !ws?.state?.playing || transport.playing) return;
  lastSharedTime = -Infinity;
  const passage = lessonPassage();
  if (passage) {
    // A lesson plays its passage, once or over and over, from wherever in it the music is.
    const inside = page.stepIndex >= passage.first && page.stepIndex <= passage.last;
    transport.start(inside ? page.stepIndex : passage.first, { last: passage.last, loop: passage.loop });
  } else {
    // From the end, play again from the top.
    transport.start(page.stepIndex >= page.steps.length - 1 ? 0 : page.stepIndex);
  }
  showPlaying(true);
}

function stopTransport() {
  preparationSerial++;
  preparingTransport = null;
  clearTimeout(cursorTimer);
  cursorTimer = null;
  if (!transport.playing) return;
  transport.stop();
  audio.releaseAll();
  showPlaying(false);
}

// Pressing Play here means the music should play here, even if another window
// or tab has this workspace open and has been the one playing it.
function togglePlaying() {
  const playing = !ws.state.playing;
  if (playing && !ws.lead) ws.claimLead().catch(() => {});
  ws.change({ playing });
}

playScore.addEventListener("click", togglePlaying);

function showTempo(tempo) {
  const previous = page.tempo;
  page.tempo = tempo;
  // The range first: a value outside the slider's range is clamped as it is set.
  showTempoTicks(page.score?.tempo ?? DEFAULT_TEMPO);
  tempoSlider.value = tempo;
  tempoOutput.value = tempo;
  if (tempo !== previous) transport.retime(previous);
}

// The slider runs from a quarter of the score's own tempo to one and a half
// times it, which puts the score's tempo about 60% of the way along whatever
// the piece; marks sit at the score's tempo and at a quarter, a half and
// three quarters of it, and clicking one sets the tempo.
const TICK_LABELS = { 0.25: "¼", 0.5: "½", 0.75: "¾" };
function showTempoTicks(normal) {
  if (tempoTicks.dataset.normal === String(normal)) return;
  tempoTicks.dataset.normal = normal;
  const low = Math.max(LIMITS.tempo[0], Math.round(normal * 0.25));
  const high = Math.min(LIMITS.tempo[1], Math.round(normal * 1.5));
  tempoSlider.min = low;
  tempoSlider.max = high;
  tempoTicks.replaceChildren(
    ...Object.entries({ ...TICK_LABELS, 1: String(normal) }).flatMap(([share, label]) => {
      const tempo = Math.round(normal * Number(share));
      if (tempo < low || tempo > high) return [];
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = `slider-tick${share === "1" ? " slider-tick--normal" : ""}`;
      tick.style.setProperty("--at", (tempo - low) / (high - low));
      tick.textContent = label;
      tick.title = share === "1" ? `The score's own tempo, ${tempo} a minute` : `${label} of the score's tempo, ${tempo} a minute`;
      tick.dataset.tempo = tempo;
      return [tick];
    }),
  );
}

tempoSlider.addEventListener("input", () => ws.change({ tempo: Number(tempoSlider.value) }));
tempoTicks.addEventListener("click", (event) => {
  const tick = event.target.closest("[data-tempo]");
  if (tick) ws.change({ tempo: Number(tick.dataset.tempo) });
});

// One hand on its own, or both: seen and heard alike.
const HAND_SETS = { left: { left: true, right: false }, both: { left: true, right: true }, right: { left: false, right: true } };
handChoice.addEventListener("click", (event) => {
  const on = HAND_SETS[event.target.closest("[data-hands]")?.dataset.hands];
  if (on) ws.change({ hands: { left: { show: on.left, sound: on.left }, right: { show: on.right, sound: on.right } } });
});

function showChoices(choices) {
  const current = Object.keys(HAND_SETS).find((choice) => HANDS.every((hand) => HAND_SETS[choice][hand] === (choices[hand].show && choices[hand].sound)));
  for (const button of handChoice.querySelectorAll("[data-hands]")) button.setAttribute("aria-pressed", String(button.dataset.hands === current));
}

numbersToggle.addEventListener("change", () => ws.change({ numbers: numbersToggle.checked }));

// Clicking a key plays it; if a finger sits on that key, the finger plays it.
handsStage.addEventListener("noteon", (event) => {
  const midi = Number(event.detail.midi);
  page.clicked.add(midi);
  audio.noteOn(midi);
  showHands({ strike: false });
});
handsStage.addEventListener("noteoff", (event) => {
  const midi = Number(event.detail.midi);
  page.clicked.delete(midi);
  audio.noteOff(midi);
  showHands({ strike: false });
});

// ---------------------------------------------------------------------------
// Learning: a passage of the piece, one hand at a time and then both, slowly
// and then faster (lesson.js). The lesson is in the workspace; the voice and
// the looping playback are this browser's doing.

// The panel shows what has been said in the phase so far, a line at a time.
const voice = new Narrator({
  fetchSpeech: serverSpeech(() => ws),
  onLine: (line) => {
    lessonPanel.caption.textContent = lessonPanel.caption.textContent ? `${lessonPanel.caption.textContent} ${line}` : line;
  },
});
function sayAfresh(lines) {
  voice.stop();
  lessonPanel.caption.textContent = "";
  return voice.sayAll(Array.isArray(lines) ? lines : [lines]);
}

const scoreTempo = () => page.score?.tempo ?? DEFAULT_TEMPO;
const lessonKey = (lesson) => (lesson ? `${lesson.from}-${lesson.to}:${lesson.stage}:${lesson.phase}` : null);

// The lesson's passage as steps to play, looping when the phase loops, or
// null when there is none.
function lessonPassage() {
  const lesson = ws?.state?.lesson;
  if (!lesson || !page.score) return null;
  const range = lessonRange(lesson, page.score.measures);
  const steps = range && lessonSteps(range, page.steps);
  return steps ? { ...steps, loop: phasePlays(lesson.phase) === "loop" ? { from: range.start, to: range.end } : null } : null;
}

// Offers the measure on screen and the few after it, to change before starting.
function offerLesson() {
  if (!page.score || !ws?.state) return;
  const { measures } = page.score;
  const shown = page.steps[page.stepIndex]?.measure;
  const offered = defaultLesson(Math.max(0, measures.findIndex((measure) => measure.number === shown)), measures.length);
  for (const select of [lessonFrom, lessonTo]) {
    select.replaceChildren(
      ...measures.map((measure, index) => {
        const option = document.createElement("option");
        option.value = index;
        option.textContent = measure.number;
        return option;
      }),
    );
  }
  lessonFrom.value = offered.from;
  lessonTo.value = offered.to;
  dialogs.lesson.showModal();
}

// Puts the workspace at the start of the passage, one hand, slow, seen from
// above. The stage change is narrated and then played by showLesson().
function startLesson(from, to) {
  const lesson = { from: Math.min(from, to), to: Math.max(from, to), stage: "right", phase: "position" };
  const range = lessonRange(lesson, page.score.measures);
  if (!range) return;
  if (!ws.lead) ws.claimLead().catch(() => {});
  const camera = { ...ws.state.camera, view: { ...OVERHEAD }, autoCut: false };
  ws.change({ lesson, time: range.start, tempo: slowTempo(scoreTempo()), hands: stageHands(lesson.stage), camera, playing: false, pose: NO_POSE });
  handsView.setCamera(camera); // a local change is not laid back on the stage by applyLatest()
}

function stopLesson() {
  if (!ws?.state?.lesson) return;
  ws.change({ lesson: null, playing: false, tempo: null, hands: stageHands("both"), pose: NO_POSE });
}

// "Got it": the next phase, or a little faster, or the next hand, or done.
function gotIt() {
  const lesson = ws?.state?.lesson;
  if (!lesson || !page.score) return;
  const target = scoreTempo();
  const next = advanceLesson(lesson, page.tempo, target);
  if (["once", "ramp", "stage"].includes(next.event)) {
    // A new phase: back to the top of the passage, quiet, the hands back to the score's, for the voice to introduce it (showLesson).
    const range = lessonRange(next.lesson, page.score.measures);
    ws.change({ lesson: next.lesson, tempo: next.tempo, hands: stageHands(next.lesson.stage), time: range.start, playing: false, pose: NO_POSE });
    return;
  }
  if (next.event === "done") ws.change({ lesson: null, tempo: target, hands: stageHands("both"), playing: false, pose: NO_POSE });
  else ws.change({ lesson: next.lesson, tempo: next.tempo }); // the music, if playing, follows the new tempo where it is
  sayAfresh(describeAdvance(next.event, { tempo: next.tempo, target }));
}

const NO_POSE = { left: null, right: null };

// Talks the phase through, then plays the passage if the phase plays it.
// While the hand is placed, each finger named goes to its key on the stage.
function narratePhase(lesson, { thenPlay = true } = {}) {
  const client = ws;
  const key = lessonKey(lesson);
  const lines = phaseLines(lesson, { score: page.score, positions: page.positions, tempo: page.tempo, target: scoreTempo() }).map((line) =>
    line?.pose ? { say: line.say, before: () => ws === client && client.change({ pose: line.pose }) } : line,
  );
  sayAfresh(lines).then((ending) => {
    if (!thenPlay || !phasePlays(lesson.phase) || ending === "dropped" || ws !== client || lessonKey(client.state?.lesson) !== key || client.state.playing) return;
    if (!client.lead) client.claimLead().catch(() => {});
    client.change({ playing: true });
  });
}

// The passage from the top; played, in a phase that plays it.
function restartLesson() {
  const lesson = ws?.state?.lesson;
  if (!lesson || !page.score) return;
  const range = lessonRange(lesson, page.score.measures);
  stopTransport();
  const playing = Boolean(phasePlays(lesson.phase));
  if (playing && !ws.lead) ws.claimLead().catch(() => {});
  ws.change({ time: range.start, playing });
}

// Lays the workspace's lesson on the screen. When a stage begins, the browser
// that began it (or the lead, when an agent did) talks it through, then plays.
function showLesson(state, { by, local }) {
  const client = ws;
  const { lesson } = state;
  const target = scoreTempo();
  lessonPanel.root.hidden = !lesson;
  learnButton.setAttribute("aria-pressed", String(Boolean(lesson)));
  learnButton.textContent = lesson ? "Learning…" : "Learn";
  if (lesson) {
    const range = lessonRange(lesson, page.score.measures);
    lessonPanel.kicker.textContent = range.from === range.to ? `Learning measure ${range.from}` : `Learning measures ${range.from}–${range.to}`;
    lessonPanel.progress.textContent = describeProgress(lesson, { tempo: page.tempo, target });
    lessonPanel.next.textContent = describeNext(lesson, { tempo: page.tempo, target });
    lessonPanel.play.textContent = state.playing ? "⏸ Pause" : "▶ Play";
    lessonPanel.play.title = state.playing ? "Pause the passage" : phasePlays(lesson.phase) === "loop" ? "Play the passage on a loop" : "Play the passage";
  }
  const key = lessonKey(lesson);
  if (key === shown.lesson) return;
  const wasOn = Boolean(shown.lesson);
  shown.lesson = key;
  if (!lesson) {
    if (wasOn && !(local || by === client.client)) voice.stop(); // ended elsewhere; the "well done" of a local finish is left to play out
    lessonPanel.caption.textContent = "";
    return;
  }
  if (!(local || (client.lead && by !== client.client))) return;
  narratePhase(lesson);
}

learnButton.addEventListener("click", () => (ws?.state?.lesson ? stopLesson() : offerLesson()));
document.querySelector("#lesson-start").addEventListener("click", () => {
  dialogs.lesson.close();
  startLesson(Number(lessonFrom.value), Number(lessonTo.value));
});
lessonPanel.next.addEventListener("click", gotIt);
lessonPanel.stop.addEventListener("click", stopLesson);
lessonPanel.play.addEventListener("click", togglePlaying);
lessonPanel.restart.addEventListener("click", restartLesson);
lessonPanel.again.addEventListener("click", () => {
  const lesson = ws?.state?.lesson;
  if (!lesson) return;
  if (lesson.phase === "position") ws.change({ pose: NO_POSE });
  narratePhase(lesson, { thenPlay: !ws.state.playing });
});

// What an agent can ask the page to do.
function runCommand(type) {
  if (type === "play") ws.change({ playing: true });
  else if (type === "stop") ws.change({ playing: false });
  else if (type.startsWith("replay-")) replay(type.slice("replay-".length));
}

document.querySelector("#step-first").addEventListener("click", () => goToStep(0));
document.querySelector("#step-prev").addEventListener("click", () => goToStep(page.stepIndex - 1));
document.querySelector("#step-next").addEventListener("click", () => goToStep(page.stepIndex + 1));

window.addEventListener("keydown", (event) => {
  // Leave typing, lists and sliders alone, and let Space and Enter work a
  // focused button or tick box. Anything else is a shortcut, wherever focus is.
  const target = event.target;
  const ticks = target.matches("input") && ["checkbox", "radio"].includes(target.type);
  if (target.matches("select, textarea") || (target.matches("input") && !ticks)) return;
  if (target.matches("button, summary, a, input") && (event.key === " " || event.key === "Enter")) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!ws?.state || document.querySelector("dialog[open]")) return;
  if (event.key === "ArrowRight") goToStep(page.stepIndex + 1);
  else if (event.key === "ArrowLeft") goToStep(page.stepIndex - 1);
  else if (event.key === "Home") goToStep(0);
  else if (event.key === "End") goToStep(page.steps.length - 1);
  else if (event.key === " ") replay(event.shiftKey ? "succession" : "together");
  else if (event.key === "p" || event.key === "P") togglePlaying();
  else if (event.key === "c" || event.key === "C") handsView.toggleAutoCut();
  else if (event.key === "n" || event.key === "N") ws.change({ numbers: !ws.state.numbers });
  else if (event.key === "f" || event.key === "F") setFullScreen(!page.fullScreen);
  else if (event.key === "l" || event.key === "L") offerLesson();
  else if (event.key === "g" || event.key === "G") gotIt();
  else if (event.key === "Escape" && page.fullScreen) setFullScreen(false);
  else if (/^[1-9]$/.test(event.key)) handsView.goToShot(Number(event.key) - 1);
  else return;
  event.preventDefault();
});

document.getElementById("guides-toggle")?.addEventListener("change", (event) => {
  page.showGuides = event.target.checked;
  drawStaffGuides();
});
renderLegend();

// ---------------------------------------------------------------------------
// Projecting the workspace onto the screen

// Changes arrive from the user's own clicks and from the server alike; each
// is laid on the screen in turn, and only what differs is redrawn.
let latest = null;
let applying = Promise.resolve();
function sync(detail) {
  latest = detail;
  applying = applying.then(applyLatest).catch((error) => console.error("MusicHands: the workspace could not be shown.", error));
}

async function applyLatest() {
  if (!latest || !ws) return;
  const { state, by, local } = latest;
  const client = ws;
  latest = null;

  const scoreKey = JSON.stringify(state.score);
  const scoresKey = JSON.stringify([client.scores, state.score?.id]);
  if (scoresKey !== shown.scores) {
    showScores();
    shown.scores = scoresKey;
  }
  if (scoreKey !== shown.scoreKey) {
    shown = { scoreKey, scores: scoresKey };
    const loaded = await loadScore(state.score);
    if (ws !== client) return; // the workspace changed while the score was on its way
    if (!loaded) return;
    if (pendingImportNotes?.id === state.score.id) {
      page.notes = pendingImportNotes.notes;
      page.doubts = pendingImportNotes.doubts;
    }
    pendingImportNotes = null;
  }
  if (!page.score) return;

  const correctionsKey = JSON.stringify(state.corrections);
  const refingered = correctionsKey !== shown.corrections;
  if (refingered) {
    refinger(state.corrections);
    shown.corrections = correctionsKey;
  }

  showTempo(state.tempo ?? page.score.tempo ?? DEFAULT_TEMPO);
  if (state.reflexes !== shown.reflexes) {
    handsView.setSpeed(state.reflexes);
    shown.reflexes = state.reflexes;
  }
  const handsKey = JSON.stringify(state.hands);
  const handsChanged = handsKey !== shown.hands;
  if (handsChanged) {
    showChoices(state.hands);
    for (const hand of HANDS) if (!state.hands[hand].sound) audio.releaseAll();
    shown.hands = handsKey;
  }
  if (state.numbers !== shown.numbers) {
    numbersToggle.checked = state.numbers;
    handsView.setNumbers(state.numbers);
    shown.numbers = state.numbers;
  }
  if (state.sound !== shown.sound) {
    audio.setEnabled(state.sound);
    shown.sound = state.sound;
  }
  const lookKey = JSON.stringify(state.look);
  if (lookKey !== shown.look) {
    showLook(state.look);
    shown.look = lookKey;
  }
  if (handsChanged && transport.playing) transport.rescheduleAudio();
  if ((refingered || handsChanged) && !state.playing) void handsView.prepareHands(scoreHandSpecs());

  const first = shown.stepIndex === undefined;
  // Server echoes of our own time updates may arrive several notes late. They
  // must not wind the live cursor backwards while the transport owns it.
  const index = transport.playing && by === client.client ? page.stepIndex : stepIndexAt(state.time);
  if (index !== shown.stepIndex || refingered) {
    page.stepIndex = index;
    shown.stepIndex = index;
    // The transport draws its own steps; a jump from elsewhere is shown at once, with sound.
    if (!transport.playing) {
      renderHands({ jump: first || refingered, sound: !first && !refingered });
      moveCursorTo(page.steps[index]?.time ?? 0);
    }
  } else if (handsChanged) showHands({ strike: false });
  // A hand put somewhere by the workspace: it goes there and presses its keys.
  const poseKey = JSON.stringify(state.pose);
  if (poseKey !== shown.pose) {
    shown.pose = poseKey;
    if (!transport.playing && !first) {
      page.poseArrived = true;
      const landing = showHands();
      page.poseArrived = false;
      for (const hand of HANDS) {
        if (!state.hands[hand].sound) continue;
        for (const note of state.pose[hand]?.press ?? []) audio.noteOn(noteToMidi(note), { delay: landing, duration: 1500 });
      }
    }
  }
  if (refingered) showSummary();
  showLesson(state, { by, local });

  // The camera is the stage's own while this browser moves it.
  if (!local) handsView.setCamera(state.camera, { immediate: first });

  if (state.playing !== transport.playing) {
    if (!state.playing) stopTransport();
    else if (client.lead) startTransport();
  }
  showPlaying(state.playing);

  const seq = state.command?.seq ?? 0;
  if (shown.commandSeq === undefined) shown.commandSeq = seq; // commands from before this visit are not repeated
  else if (seq > shown.commandSeq) {
    shown.commandSeq = seq;
    if (client.lead) runCommand(state.command.type);
  }

  if (!local && by && by !== client.client) setWorkspaceStatus(`Changed by ${by}`, "agent");
}

// ---------------------------------------------------------------------------
// The workspace: this browser's own, or one opened from a link

const hashFor = (entry) => `#ws=${entry.id}&token=${entry.token}`;

// Opens a workspace and makes the page show it.
async function openWorkspace({ id, token }) {
  stopTransport();
  player.stop();
  voice.stop();
  ws?.close();
  const client = new WorkspaceClient({ id, token });
  ws = client;
  shown = {};
  setWorkspaceStatus("Opening your workspace", "idle");
  try {
    await client.open();
  } catch (error) {
    if (ws === client) ws = null;
    throw error;
  }
  if (ws !== client) return;
  // The first workspace a browser opens is its own from then on. Another,
  // opened from a link, is a visit: the address names it, and home is a click away.
  if (!homeWorkspace()) keepHomeWorkspace(client);
  const visiting = homeWorkspace().id !== id;
  history.replaceState(null, "", visiting ? hashFor(client) : location.pathname + location.search);
  bar.home.hidden = !visiting;
  bar.string.hidden = true;
  client.addEventListener("state", (event) => {
    if (ws === client) sync(event.detail);
  });
  client.addEventListener("connection", (event) => {
    if (ws !== client) return;
    if (event.detail.connected) setWorkspaceStatus(client.lead ? "Live · this browser plays the music" : "Live · another window is playing the music · press Play to play here", "connected");
    else setWorkspaceStatus("Reconnecting to the workspace", "outside");
  });
  client.addEventListener("lead", (event) => {
    if (ws !== client || !client.connected) return;
    setWorkspaceStatus(event.detail.lead ? "Live · this browser plays the music" : "Live · another window is playing the music · press Play to play here", "connected");
    if (!event.detail.lead) stopTransport();
    else if (client.state?.playing) startTransport();
  });
  client.addEventListener("error", (event) => {
    if (ws === client) setWorkspaceStatus(`A change could not be saved: ${event.detail.error.message}`, "outside");
  });
  sync({ state: client.state, version: client.version, by: "" });
}

// Opens this browser's own workspace. A browser without one is given one,
// already holding the starter scores, so a newcomer can begin at once.
async function openHome() {
  const home = homeWorkspace();
  if (home) {
    try {
      await openWorkspace(home);
      return;
    } catch (error) {
      console.warn(`MusicHands: workspace ${home.id} could not be opened.`, error);
      // Only a workspace the server says is gone is given up; one that cannot be reached just now is still theirs.
      if (![401, 404].includes(error.status)) {
        setWorkspaceStatus(`Your workspace could not be reached: ${error.message}. Reload to try again.`, "outside");
        return;
      }
      keepHomeWorkspace(null);
    }
  }
  setWorkspaceStatus("Setting up your workspace", "idle");
  try {
    await openWorkspace(await WorkspaceClient.create("", { name: "My workspace" }));
  } catch (error) {
    setWorkspaceStatus(`Your workspace could not be set up: ${error.message}`, "outside");
  }
}

// Shows the workspace the address names, if it names one, else this browser's own.
async function openFirstWorkspace() {
  const linked = workspaceFromHash();
  if (linked) {
    try {
      await openWorkspace(linked);
      return;
    } catch (error) {
      console.warn(`MusicHands: workspace ${linked.id} could not be opened.`, error);
    }
  }
  await openHome();
}

bar.home.addEventListener("click", openHome);

bar.connect.addEventListener("click", async () => {
  if (!ws) return;
  try {
    const details = await ws.details();
    await navigator.clipboard.writeText(details.connectionString);
    setWorkspaceStatus("Connection string copied · paste it to your agent", "connected");
  } catch {
    // No clipboard: show the string so it can be copied by hand.
    bar.string.hidden = false;
    bar.string.value = ws.info?.connectionString ?? "";
    bar.string.select();
    setWorkspaceStatus("Copy the connection string from the box", "idle");
  }
});

window.addEventListener("hashchange", () => {
  const entry = workspaceFromHash();
  if (entry && entry.id !== ws?.id) openWorkspace(entry).catch((error) => setWorkspaceStatus(`That workspace could not be opened: ${error.message}`, "outside"));
});

window.musichands = { page, view: handsView, get workspace() { return ws; } };
await openFirstWorkspace();
