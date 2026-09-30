// The sheet page is a projection of a workspace. Everything on the screen —
// the score, the moment shown, tempo, camera, which hands are drawn, every
// correction — comes from the workspace document on the server, and every
// click here is a change to that document. An agent with the workspace's
// connection string sees and changes the same things through the API.
import { assignFingering } from "./fingering.js";
import { noteToMidi } from "./hand-model.js";
import { applyHandMoves, countCorrections, matchingMoments, momentKey, withCorrection } from "./corrections.js";
import { applyChoices, HANDS } from "./hand-choices.js";
import { HandPlayer } from "./hand-player.js";
import { createHandView } from "./hand-view.js";
import { PianoAudio } from "./piano-audio.js";
import { readMxl } from "./mxl.js";
import { parseScore } from "./score-model.js";
import { ScoreTransport } from "./score-transport.js";
import { forgetWorkspace, parseConnection, rememberedWorkspaces, rememberWorkspace, WorkspaceClient, workspaceFromHash } from "./workspace-client.js";

const scoreSelect = document.querySelector("#score-select");
const scoreFile = document.querySelector("#score-file");
const scoreTitle = document.querySelector("#score-title");
const scoreContainer = document.querySelector("#score-container");
const status = document.querySelector("#sheet-status");
const statusText = document.querySelector("#sheet-status-text");
const handsKicker = document.querySelector("#hands-kicker");
const handsTitle = document.querySelector("#hands-title");
const fingeringNote = document.querySelector("#fingering-note");
const handsStage = document.querySelector("#hands-stage");
const soundToggle = document.querySelector("#sound-toggle");
const numbersToggle = document.querySelector("#numbers-toggle");
const playButtons = {
  together: document.querySelector("#play-together"),
  succession: document.querySelector("#play-succession"),
  roundtrip: document.querySelector("#play-roundtrip"),
};
const DEFAULT_TEMPO = 120; // quarter notes a minute, for scores that do not state one
const importedScores = document.querySelector("#imported-scores");
const libraryActions = document.querySelector("#library-actions");
const dropHint = document.querySelector("#drop-hint");
const handsPanel = document.querySelector(".hands-panel");
const playScore = document.querySelector("#play-score");
const tempoSlider = document.querySelector("#tempo");
const tempoOutput = document.querySelector("#tempo-output");
const reflexSlider = document.querySelector("#reflex");
const reflexOutput = document.querySelector("#reflex-output");
const captions = {
  right: document.querySelector("#right-hand-caption"),
  left: document.querySelector("#left-hand-caption"),
};
const positionLists = {
  right: document.querySelector("#right-positions"),
  left: document.querySelector("#left-positions"),
};
const bar = {
  select: document.querySelector("#workspace-select"),
  name: document.querySelector("#workspace-name"),
  fresh: document.querySelector("#workspace-new"),
  copy: document.querySelector("#workspace-copy"),
  open: document.querySelector("#workspace-open"),
  connect: document.querySelector("#workspace-connect"),
  status: document.querySelector("#workspace-status"),
  statusText: document.querySelector("#workspace-status-text"),
  form: document.querySelector("#workspace-open-form"),
  paste: document.querySelector("#workspace-paste"),
  cancel: document.querySelector("#workspace-open-cancel"),
};
const editor = {
  details: document.querySelector("#finger-editor"),
  rows: document.querySelector("#finger-editor-rows"),
  source: document.querySelector("#finger-editor-source"),
  everywhere: document.querySelector("#finger-everywhere"),
  clear: document.querySelector("#finger-clear"),
  status: document.querySelector("#finger-editor-status"),
};
const UPLOADS = "musichands-uploads"; // scores this browser has sent to the server: [{ id, title }]

const SOURCE_LABEL = {
  score: "fingering from the score",
  override: "corrected fingering",
  heuristic: "fingering is a guess",
};

// What the page has worked out from the workspace: the score as read, its
// fingering, and the transient things only this browser knows (which keys the
// pointer holds, what the play buttons are sounding).
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
  measureShown: null, // the measure the hands were last shown in
  sidecar: {}, // fingerings that came with a bundled score
  notes: [],
  doubts: [],
};
// The workspace as it is on the screen, so only what changed is redrawn.
let shown = {};
let ws = null; // the open WorkspaceClient
let uploads = readUploads();

const handsView = await createHandView(handsStage, {
  interactive: true,
  autoCut: true,
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

function describeFingers(fingers) {
  const thumb = fingers.find((entry) => entry.finger === 1)?.note;
  const pinky = fingers.find((entry) => entry.finger === 5)?.note;
  const parts = [];
  if (thumb) parts.push(`thumb on ${thumb}`);
  if (pinky) parts.push(`pinky on ${pinky}`);
  if (!parts.length) parts.push(fingers.map((entry) => `${entry.finger} on ${entry.note}`).join(", "));
  return parts.join(" · ");
}

function measureLabel(position) {
  return position.startMeasure === position.endMeasure
    ? `m. ${position.startMeasure}`
    : `mm. ${position.startMeasure}–${position.endMeasure}`;
}

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
  const fingered = assignFingering(moved, { overrides: { ...page.sidecar, ...corrections.fingers } });
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

async function loadSidecar(url) {
  const sidecar = url.replace(/\.(musicxml|xml)$/i, ".fingering.json");
  try {
    const response = await fetch(sidecar);
    return response.ok ? await response.json() : {};
  } catch {
    return {};
  }
}

// Fetches and reads the score a workspace names. Returns false if it cannot.
async function loadScore(score) {
  const label = score.title || "the score";
  setStatus(`Reading ${label}`, "idle");
  stopTransport();
  let xml;
  try {
    const response = await fetch(score.kind === "bundled" ? score.url : `./api/scores/${score.id}`);
    if (!response.ok) throw new Error(response.status === 404 ? "it is not on this server" : `the server answered ${response.status}`);
    xml = await response.text();
    page.score = parseScore(xml);
  } catch (error) {
    page.score = null;
    setStatus(`Could not read ${label}: ${error.message}`, "outside");
    return false;
  }
  page.xml = xml;
  page.sidecar = score.kind === "bundled" ? await loadSidecar(score.url) : {};
  page.notes = [];
  page.doubts = [];
  page.measureShown = null;
  scoreTitle.textContent = page.score.title;
  document.title = `MusicHands — ${page.score.title}`;
  showScoreChoice(score);
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
  const { shown: drawn, ghost } = applyChoices(moment, ws.state.hands);
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
  const landing = handsView.setHands(hands, { immediate: jump, landIn });
  // Keys with no hand on them: clicked ones, and those of a hand that is hidden.
  const loose = [...page.clicked, ...(page.replay ?? [...ghost.held, ...ghost.struck])].filter((midi) => !underFinger.has(midi));
  const struckLoose = strike && !jump ? (page.replay ? [...page.replay] : ghost.struck).filter((midi) => !underFinger.has(midi)) : [];
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
  if (landIn !== null) queuePlaybackDetails();
  else renderHandDetails();
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

let detailsTimer = null;
function queuePlaybackDetails() {
  if (detailsTimer !== null) return;
  detailsTimer = setTimeout(() => {
    detailsTimer = null;
    renderHandDetails();
    moveCursorTo(page.steps[page.stepIndex].time);
  }, 100);
}

function renderHandDetails() {
  const step = page.steps[page.stepIndex];
  if (!step) return;
  const beat = Number.isInteger(step.beat) ? step.beat : step.beat.toFixed(2).replace(/0+$/, "");
  handsKicker.textContent = `Measure ${step.measure} · beat ${beat}`;
  const sources = new Set();
  const moment = momentAt(step);

  ["right", "left"].forEach((hand) => {
    const entry = moment[hand];
    if (!entry) {
      captions[hand].dataset.state = "silent";
      captions[hand].textContent = `${hand === "right" ? "Right" : "Left"} hand · not yet playing`;
      return;
    }
    captions[hand].dataset.state = entry.striking ? "playing" : "holding";
    captions[hand].textContent = `${hand === "right" ? "Right" : "Left"} hand · ${measureLabel(entry.position)} · ${describeFingers(entry.position.fingers)}`;
    if (entry.event) sources.add(entry.event.fingeringSource);
  });
  const playable = Object.values(moment).some((entry) => entry.sounding.length);
  Object.values(playButtons).forEach((button) => {
    button.disabled = !playable;
  });

  const labels = [...sources].map((source) => SOURCE_LABEL[source]);
  fingeringNote.textContent = labels.length ? labels.join(" · ") : "";
  fingeringNote.dataset.source = sources.has("heuristic") ? "heuristic" : "authored";
  handsTitle.textContent = step.events.length === 1 ? `${step.events[0].hand === "right" ? "Right" : "Left"} hand plays` : "Both hands play";
  if (editor.details.open) renderFingerEditor();

  Object.values(positionLists).forEach((list) => {
    list.querySelectorAll(".position-card").forEach((card) => {
      const active = Number(card.dataset.start) <= step.time && Number(card.dataset.end) > step.time;
      if (card.classList.contains("is-current") === active) return;
      card.classList.toggle("is-current", active);
      // Scroll the rail sideways to the current card without moving the page itself.
      if (active) list.scrollTo({ left: card.offsetLeft - list.clientWidth / 2 + card.clientWidth / 2, behavior: "smooth" });
    });
  });
}

function moveCursorTo(time) {
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
  // Keep the cursor in the part of the window the hands panel does not cover.
  const box = cursorElement.getBoundingClientRect();
  const floor = Math.min(window.innerHeight, handsPanel.getBoundingClientRect().top);
  const comfortable = box.top > 70 && box.bottom < floor - 30;
  if (!comfortable) window.scrollBy({ top: box.top + box.height / 2 - floor / 2, behavior: "smooth" });
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

function renderPositionLists() {
  ["right", "left"].forEach((hand) => {
    const list = positionLists[hand];
    list.innerHTML = "";
    page.positions[hand].forEach((position, index) => {
      const item = document.createElement("li");
      item.className = "position-card";
      item.dataset.start = position.startTime;
      item.dataset.end = position.endTime;
      item.dataset.source = position.sources.includes("heuristic") ? "heuristic" : "authored";
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.innerHTML = `
        <div class="position-card__art"></div>
        <div class="position-card__meta">
          <span class="position-card__index">${index + 1}</span>
          <strong>${measureLabel(position)}</strong>
          <span>${describeFingers(position.fingers)}</span>
        </div>`;
      handsView.renderCard(item.querySelector(".position-card__art"), hand, position.fingers);
      const jump = () => goToTime(position.startTime);
      item.addEventListener("click", jump);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          jump();
        }
      });
      list.append(item);
    });
  });
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
      drawStaffGuides();
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

// Clicking a measure in the notation jumps the hands to that measure. The
// listener sits on the container because OSMD replaces its SVG on every render.
function measureAtPoint(clientX, clientY) {
  const { osmd } = page;
  const svg = scoreContainer.querySelector("svg");
  if (!osmd?.GraphicSheet || !svg) return null;
  const rect = svg.getBoundingClientRect();
  const unit = 10 * (osmd.zoom ?? 1) * (rect.width / Number(svg.getAttribute("width") || rect.width));
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
// Corrections: which finger, and which hand

const SOURCE_WORD = { score: "from the score", override: "corrected", heuristic: "a guess" };
const OTHER = { right: "left", left: "right" };

function renderFingerEditor() {
  const step = page.steps[page.stepIndex];
  editor.rows.replaceChildren();
  if (!step || !ws?.state) return;
  const { fingers, hands: moves } = ws.state.corrections;
  const sources = new Set();
  let corrected = false;
  for (const hand of ["right", "left"]) {
    const event = step.events.find((entry) => entry.hand === hand);
    if (!event) continue;
    const key = momentKey(event);
    const row = document.createElement("div");
    row.className = "finger-row-edit";
    const label = document.createElement("span");
    label.className = "finger-row-edit__hand";
    label.textContent = hand === "right" ? "Right" : "Left";
    row.append(label);
    const overrideHere = fingers[key]?.[hand] ?? {};
    const written = page.score.events.find((raw) => raw.hand === hand && raw.time === event.time);
    for (const note of [...event.notes].sort((a, b) => a.midi - b.midi)) {
      const moved = moves[key]?.[note.note] === hand; // given to this hand by a correction
      const authored = overrideHere[note.note] ? "override" : !moved && written?.notes.find((raw) => raw.midi === note.midi)?.finger ? "score" : "heuristic";
      sources.add(authored);
      if (moved || authored === "override") corrected = true;
      const pick = document.createElement("span");
      pick.className = `finger-pick finger-pick--${authored}${moved ? " finger-pick--moved" : ""}`;
      pick.title = moved ? `${note.note}: moved here from the ${OTHER[hand]} hand; fingering ${SOURCE_WORD[authored]}` : `${note.note}: fingering ${SOURCE_WORD[authored]}`;
      const name = document.createElement("span");
      name.textContent = note.note;
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Finger for ${note.note}, ${hand} hand`);
      for (const finger of [1, 2, 3, 4, 5]) {
        const option = document.createElement("option");
        option.value = finger;
        option.textContent = finger;
        option.selected = finger === note.finger;
        select.append(option);
      }
      select.addEventListener("change", () => correctFinger(event, note.note, Number(select.value)));
      const move = document.createElement("button");
      move.type = "button";
      move.className = "finger-pick__move";
      move.textContent = moved ? "↩" : "⇄";
      move.title = moved ? `Give ${note.note} back to the ${OTHER[hand]} hand` : `Play ${note.note} with the ${OTHER[hand]} hand instead`;
      move.setAttribute("aria-label", move.title);
      move.addEventListener("click", () => moveNote(event, note.note, moved ? null : OTHER[hand]));
      pick.append(name, select, move);
      row.append(pick);
    }
    editor.rows.append(row);
  }
  const word = sources.has("override") ? "corrected" : sources.has("heuristic") ? "a guess" : sources.size ? "from the score" : "";
  editor.source.textContent = word;
  editor.source.dataset.source = sources.has("override") ? "override" : sources.has("heuristic") ? "heuristic" : "score";
  editor.clear.hidden = !corrected;
}

// The moments a correction made here reaches: this one, or every one where the
// same hand plays the same notes.
const reach = (event) => (editor.everywhere.checked ? matchingMoments(page.events, event) : [event]);

function correctFinger(event, note, finger) {
  const moments = reach(event);
  const fingers = withCorrection({}, moments, event.hand, note, finger);
  ws.change({ corrections: { fingers } });
  noteCorrection(`${note} → ${finger}${moments.length > 1 ? ` in ${moments.length} places` : ""}`);
}

// Gives a note to `hand` at this moment (and matching ones), or back to the score's hand when null.
function moveNote(event, note, hand) {
  const moments = reach(event);
  const moves = {};
  for (const moment of moments) moves[momentKey(moment)] = { [note]: hand };
  ws.change({ corrections: { hands: moves } });
  noteCorrection(hand ? `${note} → ${hand} hand${moments.length > 1 ? ` in ${moments.length} places` : ""}` : `${note} back to the score's hand`);
}

function noteCorrection(what) {
  editor.status.textContent = `Kept in this workspace: ${what}`;
  editor.status.dataset.state = "saved";
}

editor.clear.addEventListener("click", () => {
  const step = page.steps[page.stepIndex];
  if (!step) return;
  const fingers = {};
  const hands = {};
  for (const event of step.events) {
    fingers[momentKey(event)] = null;
    hands[momentKey(event)] = null;
  }
  ws.change({ corrections: { fingers, hands } });
  noteCorrection("corrections here removed");
});
try {
  editor.details.open = localStorage.getItem("musichands-finger-editor") === "open";
} catch {
  // Closed, then.
}
editor.details.addEventListener("toggle", () => {
  if (editor.details.open) renderFingerEditor();
  try {
    localStorage.setItem("musichands-finger-editor", editor.details.open ? "open" : "closed");
  } catch {
    // Not remembered.
  }
});

// ---------------------------------------------------------------------------
// Scores: bundled ones, and ones sent to the server

function readUploads() {
  try {
    const list = JSON.parse(localStorage.getItem(UPLOADS) ?? "[]");
    return Array.isArray(list) ? list.filter((entry) => /^[0-9a-f]{64}$/.test(entry?.id)) : [];
  } catch {
    return [];
  }
}

function writeUploads(list) {
  uploads = list.slice(0, 40);
  try {
    localStorage.setItem(UPLOADS, JSON.stringify(uploads));
  } catch {
    // The list lasts only for this visit.
  }
  showUploads();
}

function showUploads() {
  importedScores.replaceChildren(
    ...uploads.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.title;
      return option;
    }),
  );
  importedScores.hidden = uploads.length === 0;
}

// Marks the open score in the list, adding an uploaded one the list did not know.
function showScoreChoice(score) {
  const value = score.kind === "bundled" ? score.url : score.id;
  if (score.kind === "uploaded" && !uploads.some((entry) => entry.id === score.id)) {
    writeUploads([{ id: score.id, title: score.title || page.score?.title || "Uploaded score" }, ...uploads]);
  }
  scoreSelect.value = value;
  if (scoreSelect.value !== value) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = score.title || value;
    scoreSelect.append(option);
    scoreSelect.value = value;
  }
  libraryActions.hidden = score.kind !== "uploaded";
}

// Points the workspace at another piece. Corrections are by moment, so they
// stay behind with the piece they were made for.
function chooseScore(score) {
  ws.change({ score, time: 0, playing: false, corrections: { fingers: null, hands: null } });
}

scoreSelect.addEventListener("change", () => {
  const value = scoreSelect.value;
  const option = scoreSelect.selectedOptions[0];
  if (/^[0-9a-f]{64}$/.test(value)) chooseScore({ kind: "uploaded", id: value, title: option?.textContent ?? "" });
  else chooseScore({ kind: "bundled", url: value, title: option?.textContent ?? "" });
});

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
    setStatus(`Sending ${named} to the server`, "idle");
    const uploaded = await ws.uploadScore(xml);
    writeUploads([{ id: uploaded.id, title: named }, ...uploads.filter((entry) => entry.id !== uploaded.id)]);
    // What the reader had to guess at is worth saying once the piece is up.
    pendingImportNotes = { id: uploaded.id, notes, doubts };
    chooseScore({ kind: "uploaded", id: uploaded.id, title: named });
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

document.querySelector("#save-score").addEventListener("click", () => {
  if (!page.xml) return;
  const url = URL.createObjectURL(new Blob([page.xml], { type: "application/vnd.recordare.musicxml+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${page.score.title.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "score"}.musicxml`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelector("#remove-score").addEventListener("click", () => {
  const id = scoreSelect.value;
  if (!/^[0-9a-f]{64}$/.test(id)) return;
  writeUploads(uploads.filter((entry) => entry.id !== id));
  const first = scoreSelect.querySelector("optgroup:not([hidden]) option");
  if (first) chooseScore({ kind: "bundled", url: first.value, title: first.textContent });
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
  onChange: (mode) => {
    for (const [name, button] of Object.entries(playButtons)) button.classList.toggle("is-playing", name === mode);
  },
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

for (const [mode, button] of Object.entries(playButtons)) button.addEventListener("click", () => replay(mode));

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
  const preparation = Promise.all([handsView.prepareHands(scoreHandSpecs()), audio.prepare()]);
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
  // From the end, play again from the top.
  const from = page.stepIndex >= page.steps.length - 1 ? 0 : page.stepIndex;
  lastSharedTime = -Infinity;
  transport.start(from);
  showPlaying(true);
}

function stopTransport() {
  preparationSerial++;
  preparingTransport = null;
  clearTimeout(detailsTimer);
  detailsTimer = null;
  if (!transport.playing) return;
  transport.stop();
  audio.releaseAll();
  showPlaying(false);
}

playScore.addEventListener("click", () => ws.change({ playing: !ws.state.playing }));

function showTempo(tempo) {
  const previous = page.tempo;
  page.tempo = tempo;
  tempoSlider.value = tempo;
  tempoOutput.value = tempo;
  if (tempo !== previous) transport.retime(previous);
}

tempoSlider.addEventListener("input", () => ws.change({ tempo: Number(tempoSlider.value) }));
reflexSlider.addEventListener("input", () => ws.change({ reflexes: Number(reflexSlider.value) }));

// Which hands to draw and to hear, and whether to number the fingers.
for (const hand of HANDS) {
  for (const what of ["show", "sound"]) {
    const box = document.querySelector(`#${hand}-${what}`);
    box.addEventListener("change", () => ws.change({ hands: { [hand]: { [what]: box.checked } } }));
  }
}

function showChoices(choices) {
  for (const hand of HANDS) {
    const strip = document.querySelector(`.hand-strip[data-hand="${hand}"]`);
    strip.classList.toggle("is-hidden", !choices[hand].show);
    strip.classList.toggle("is-silent", !choices[hand].sound);
    for (const what of ["show", "sound"]) document.querySelector(`#${hand}-${what}`).checked = choices[hand][what];
  }
}

numbersToggle.addEventListener("change", () => ws.change({ numbers: numbersToggle.checked }));
soundToggle.addEventListener("change", () => ws.change({ sound: soundToggle.checked }));

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
  if (!ws?.state) return;
  if (event.key === "ArrowRight") goToStep(page.stepIndex + 1);
  else if (event.key === "ArrowLeft") goToStep(page.stepIndex - 1);
  else if (event.key === "Home") goToStep(0);
  else if (event.key === "End") goToStep(page.steps.length - 1);
  else if (event.key === " ") replay(event.shiftKey ? "succession" : "together");
  else if (event.key === "p" || event.key === "P") ws.change({ playing: !ws.state.playing });
  else if (event.key === "c" || event.key === "C") handsView.toggleAutoCut();
  else if (event.key === "n" || event.key === "N") ws.change({ numbers: !ws.state.numbers });
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
  if (scoreKey !== shown.scoreKey) {
    shown = { scoreKey };
    const loaded = await loadScore(state.score);
    if (ws !== client) return; // the workspace changed while the score was on its way
    if (!loaded) return;
    if (pendingImportNotes && pendingImportNotes.id === state.score.id) {
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
    renderPositionLists();
    shown.corrections = correctionsKey;
  }

  showTempo(state.tempo ?? page.score.tempo ?? DEFAULT_TEMPO);
  if (state.reflexes !== shown.reflexes) {
    reflexSlider.value = state.reflexes;
    reflexOutput.value = `${state.reflexes}×`;
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
    soundToggle.checked = state.sound;
    audio.setEnabled(state.sound);
    shown.sound = state.sound;
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
  if (refingered) showSummary();

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
// Workspaces: opening, switching, making, and handing to an agent

function showWorkspaceList() {
  const known = rememberedWorkspaces();
  bar.select.replaceChildren(
    ...known.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.name || entry.id;
      option.selected = entry.id === ws?.id;
      return option;
    }),
  );
  bar.name.value = ws?.name ?? "";
}

const hashFor = (entry) => `#ws=${entry.id}&token=${entry.token}`;

// Opens a workspace and makes the page show it.
async function openWorkspace({ id, token }) {
  stopTransport();
  player.stop();
  ws?.close();
  const client = new WorkspaceClient({ id, token });
  ws = client;
  shown = {};
  setWorkspaceStatus("Opening the workspace", "idle");
  try {
    await client.open();
  } catch (error) {
    if (ws === client) ws = null;
    forgetWorkspace(id);
    throw error;
  }
  if (ws !== client) return;
  rememberWorkspace({ id, token, name: client.name });
  if (location.hash !== hashFor(client)) history.replaceState(null, "", hashFor(client));
  showWorkspaceList();
  client.addEventListener("state", (event) => {
    if (ws === client) sync(event.detail);
  });
  client.addEventListener("connection", (event) => {
    if (ws !== client) return;
    if (event.detail.connected) setWorkspaceStatus(client.lead ? "Live · this browser plays the music" : "Live · following", "connected");
    else setWorkspaceStatus("Reconnecting to the workspace", "outside");
  });
  client.addEventListener("lead", (event) => {
    if (ws !== client || !client.connected) return;
    setWorkspaceStatus(event.detail.lead ? "Live · this browser plays the music" : "Live · following", "connected");
    if (!event.detail.lead) stopTransport();
    else if (client.state?.playing) startTransport();
  });
  client.addEventListener("error", (event) => {
    if (ws === client) setWorkspaceStatus(`A change could not be saved: ${event.detail.error.message}`, "outside");
  });
  sync({ state: client.state, version: client.version, by: "" });
}

// Finds a workspace to show: the one in the address, then the last one this
// browser opened, else a new one.
async function openFirstWorkspace() {
  const candidates = [workspaceFromHash(), ...rememberedWorkspaces()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await openWorkspace(candidate);
      return;
    } catch (error) {
      console.warn(`MusicHands: workspace ${candidate.id} could not be opened.`, error);
    }
  }
  await makeWorkspace({ name: "My workspace" });
}

async function makeWorkspace(body) {
  setWorkspaceStatus("Making a workspace", "idle");
  try {
    const made = await WorkspaceClient.create("", body);
    await openWorkspace(made);
  } catch (error) {
    setWorkspaceStatus(`The workspace could not be made: ${error.message}`, "outside");
  }
}

bar.select.addEventListener("change", () => {
  const entry = rememberedWorkspaces().find((known) => known.id === bar.select.value);
  if (entry && entry.id !== ws?.id) openWorkspace(entry).catch((error) => setWorkspaceStatus(`That workspace could not be opened: ${error.message}`, "outside"));
});

bar.name.addEventListener("change", async () => {
  if (!ws || !bar.name.value.trim()) return;
  try {
    const name = await ws.rename(bar.name.value.trim());
    rememberWorkspace({ id: ws.id, token: ws.token, name });
    showWorkspaceList();
  } catch (error) {
    setWorkspaceStatus(`The name could not be changed: ${error.message}`, "outside");
  }
});

bar.fresh.addEventListener("click", () => makeWorkspace({ name: `Workspace ${rememberedWorkspaces().length + 1}` }));
bar.copy.addEventListener("click", () => {
  if (ws) makeWorkspace({ name: `${ws.name} (copy)`, copyFrom: { id: ws.id, token: ws.token } });
});

bar.open.addEventListener("click", () => {
  bar.form.hidden = !bar.form.hidden;
  if (!bar.form.hidden) bar.paste.focus();
});
bar.cancel.addEventListener("click", () => {
  bar.form.hidden = true;
});
bar.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = parseConnection(bar.paste.value);
  if (!entry) {
    setWorkspaceStatus("That does not look like a workspace link or connection string", "outside");
    return;
  }
  try {
    await openWorkspace(entry);
    bar.form.hidden = true;
    bar.paste.value = "";
  } catch (error) {
    setWorkspaceStatus(`That workspace could not be opened: ${error.message}`, "outside");
  }
});

bar.connect.addEventListener("click", async () => {
  if (!ws) return;
  try {
    const details = await ws.details();
    await navigator.clipboard.writeText(details.connectionString);
    setWorkspaceStatus("Connection string copied · paste it to your agent", "connected");
  } catch {
    // No clipboard: show the string so it can be copied by hand.
    bar.form.hidden = false;
    bar.paste.value = ws.info?.connectionString ?? "";
    bar.paste.select();
    setWorkspaceStatus("Copy the connection string from the box", "idle");
  }
});

window.addEventListener("hashchange", () => {
  const entry = workspaceFromHash();
  if (entry && entry.id !== ws?.id) openWorkspace(entry).catch((error) => setWorkspaceStatus(`That workspace could not be opened: ${error.message}`, "outside"));
});

showUploads();
window.musichands = { page, get workspace() { return ws; } };
await openFirstWorkspace();
