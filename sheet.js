import { assignFingering } from "./fingering.js";
import { noteToMidi } from "./hand-model.js";
import { HandPlayer } from "./hand-player.js";
import { createHandView } from "./hand-view.js";
import { PianoAudio } from "./piano-audio.js";
import { readMxl } from "./mxl.js";
import { parseScore } from "./score-model.js";

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
const handsView = await createHandView(handsStage, { interactive: true });
const audio = new PianoAudio({ enabled: localStorage.getItem("musichands-sound") !== "off" });
const soundToggle = document.querySelector("#sound-toggle");
const playButtons = {
  together: document.querySelector("#play-together"),
  succession: document.querySelector("#play-succession"),
};
const TEMPO = 120; // quarter notes a minute, until the score's own tempo is read
const captions = {
  right: document.querySelector("#right-hand-caption"),
  left: document.querySelector("#left-hand-caption"),
};
const positionLists = {
  right: document.querySelector("#right-positions"),
  left: document.querySelector("#left-positions"),
};

const SOURCE_LABEL = {
  score: "fingering from the score",
  override: "fingering from the sidecar file",
  heuristic: "fingering is a guess",
};

const state = {
  score: null,
  events: [],
  steps: [],
  positions: { right: [], left: [] },
  stepIndex: 0,
  osmd: null,
  showGuides: true,
  clicked: new Set(), // keys held down by the pointer
  replay: null, // notes the play buttons are holding, or null
};

function setStatus(message, stateName = "idle") {
  statusText.textContent = message;
  status.dataset.state = stateName;
}

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
  const times = [...new Set(events.filter((event) => event.attack).map((event) => event.time))].sort((a, b) => a - b);
  return times.map((time) => ({
    time,
    events: events.filter((event) => event.time === time),
    measure: events.find((event) => event.time === time).measure,
    beat: events.find((event) => event.time === time).beat,
  }));
}

function positionAt(hand, time) {
  const list = state.positions[hand];
  let found = null;
  for (const position of list) {
    if (position.startTime <= time) found = position;
    else break;
  }
  return found;
}

function eventAt(hand, time) {
  let found = null;
  for (const event of state.events) {
    if (event.hand !== hand) continue;
    if (event.time <= time) found = event;
    else break;
  }
  return found;
}

// What each hand is doing at a step: where it sits, which notes it holds, and
// which of those it strikes at that very moment.
function momentAt(step) {
  const moment = {};
  ["right", "left"].forEach((hand) => {
    const position = positionAt(hand, step.time);
    const event = eventAt(hand, step.time);
    if (!position) return;
    const sounding = event && event.time + event.duration > step.time ? event.notes.map((note) => note.midi) : [];
    moment[hand] = { position, event, sounding, striking: event?.time === step.time };
  });
  return moment;
}

// Puts the hands on the stage for the current step. The play buttons and the
// pointer can both press keys on top of what the score holds down. Returns the
// milliseconds until struck keys land.
function showHands({ jump = false, strike = true } = {}) {
  const step = state.steps[state.stepIndex];
  if (!step) return 0;
  const moment = momentAt(step);
  const hands = { left: null, right: null };
  const underFinger = new Set();
  for (const [hand, { position, sounding, striking }] of Object.entries(moment)) {
    const assigned = new Set(position.fingers.map((entry) => noteToMidi(entry.note)));
    assigned.forEach((midi) => underFinger.add(midi));
    const held = state.replay ? [...state.replay] : sounding;
    const active = [...new Set([...held, ...state.clicked])].filter((midi) => assigned.has(midi));
    hands[hand] = { fingers: position.fingers, activeMidis: active, strike: strike && (state.replay ? active.length > 0 : striking) };
  }
  handsView.setSounding([...state.clicked, ...(state.replay ?? [])].filter((midi) => !underFinger.has(midi)));
  return handsView.setHands(hands, { immediate: jump });
}

function renderHands({ jump = false, sound = false } = {}) {
  const step = state.steps[state.stepIndex];
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
  player.stop();
  const landing = showHands({ jump });
  if (sound) {
    // Notes still held from before keep ringing; everything else is damped.
    const held = Object.values(moment).flatMap((entry) => (entry.striking ? [] : entry.sounding));
    audio.releaseAll({ except: held });
    for (const entry of Object.values(moment)) {
      if (!entry.striking) continue;
      // Stepping by hand is slower than the music, so let short notes ring long enough to hear.
      const duration = Math.min(4000, Math.max(1200, (entry.event.duration * 60000) / TEMPO));
      for (const midi of entry.sounding) audio.noteOn(midi, { delay: landing, duration });
    }
  }
  const playable = Object.values(moment).some((entry) => entry.sounding.length);
  Object.values(playButtons).forEach((button) => {
    button.disabled = !playable;
  });

  const labels = [...sources].map((source) => SOURCE_LABEL[source]);
  fingeringNote.textContent = labels.length ? labels.join(" · ") : "";
  fingeringNote.dataset.source = sources.has("heuristic") ? "heuristic" : "authored";
  handsTitle.textContent = step.events.length === 1 ? `${step.events[0].hand === "right" ? "Right" : "Left"} hand plays` : "Both hands play";

  Object.values(positionLists).forEach((list) => {
    list.querySelectorAll(".position-card").forEach((card) => {
      const active = Number(card.dataset.start) <= step.time && Number(card.dataset.end) > step.time;
      card.classList.toggle("is-current", active);
      // Scroll the rail sideways to the current card without moving the page itself.
      if (active) list.scrollTo({ left: card.offsetLeft - list.clientWidth / 2 + card.clientWidth / 2, behavior: "smooth" });
    });
  });
}

function moveCursorTo(time) {
  const { osmd } = state;
  if (!osmd?.cursor) return;
  const cursor = osmd.cursor;
  // OSMD measures time in whole notes; the model uses quarter notes.
  const target = time / 4 - 1e-6;
  cursor.reset();
  let guard = 0;
  while (!cursor.iterator.EndReached && cursor.iterator.currentTimeStamp.RealValue < target && guard < 5000) {
    cursor.next();
    guard += 1;
  }
  cursor.show();
  const cursorElement = cursor.cursorElement;
  if (cursorElement) cursorElement.scrollIntoView({ block: "center", behavior: "smooth" });
}

function goToStep(index, { jump = false } = {}) {
  state.stepIndex = Math.max(0, Math.min(state.steps.length - 1, index));
  renderHands({ jump, sound: !jump });
  moveCursorTo(state.steps[state.stepIndex].time);
}

function goToTime(time) {
  const index = state.steps.findIndex((step) => step.time >= time - 1e-6);
  goToStep(index === -1 ? state.steps.length - 1 : index);
}

function renderPositionLists() {
  ["right", "left"].forEach((hand) => {
    const list = positionLists[hand];
    list.innerHTML = "";
    state.positions[hand].forEach((position, index) => {
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

async function renderNotation(xmlText) {
  if (!window.opensheetmusicdisplay) {
    scoreContainer.innerHTML = `<p class="score-fallback">The notation renderer could not be loaded. The hand positions below still work.</p>`;
    return;
  }
  if (!state.osmd) {
    state.osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(scoreContainer, {
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
    const render = state.osmd.render.bind(state.osmd);
    state.osmd.render = () => {
      render();
      drawStaffGuides();
    };
  }
  await state.osmd.load(xmlText);
  state.osmd.render();
  state.osmd.cursor.show();
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
  const { osmd } = state;
  const svg = scoreContainer.querySelector("svg");
  if (!svg) return;
  svg.querySelector(".staff-guides")?.remove();
  if (!osmd?.GraphicSheet || !state.showGuides) return;

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

  for (const page of osmd.GraphicSheet.MusicPages) {
    for (const system of page.MusicSystems) {
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
  const { osmd } = state;
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
  const measure = state.score?.measures[index];
  if (measure) goToTime(measure.start);
});

async function loadOverrides(url) {
  if (!url) return {};
  const sidecar = url.replace(/\.(musicxml|xml)$/i, ".fingering.json");
  try {
    const response = await fetch(sidecar);
    if (!response.ok) return {};
    return await response.json();
  } catch {
    return {};
  }
}

async function loadScore(xmlText, { overrideUrl = null, label = "score" } = {}) {
  setStatus(`Reading ${label}`, "idle");
  try {
    state.score = parseScore(xmlText);
  } catch (error) {
    setStatus(`Could not read ${label}: ${error.message}`, "outside");
    return;
  }
  const overrides = await loadOverrides(overrideUrl);
  const fingered = assignFingering(state.score.events, { overrides });
  state.events = fingered.events;
  state.positions = fingered.positions;
  state.steps = buildSteps(state.events);
  scoreTitle.textContent = state.score.title;
  document.title = `MusicHands — ${state.score.title}`;
  renderPositionLists();
  goToStep(0, { jump: true });

  const guessed = state.events.filter((event) => event.fingeringSource === "heuristic").length;
  setStatus(
    guessed
      ? `${state.score.measures.length} measures · ${state.positions.right.length + state.positions.left.length} hand positions · ${guessed} of ${state.events.length} moments use guessed fingering`
      : `${state.score.measures.length} measures · ${state.positions.right.length + state.positions.left.length} hand positions · fingering fully authored`,
    "connected",
  );

  try {
    await renderNotation(xmlText);
    moveCursorTo(state.steps[state.stepIndex]?.time ?? 0);
  } catch (error) {
    scoreContainer.innerHTML = `<p class="score-fallback">The notation could not be drawn: ${error.message}</p>`;
  }
}

async function loadScoreUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    setStatus(`Could not fetch ${url}`, "outside");
    return;
  }
  await loadScore(await response.text(), { overrideUrl: url, label: scoreSelect.selectedOptions[0]?.textContent ?? url });
}

async function readScoreFile(file) {
  try {
    const xmlText = /\.mxl$/i.test(file.name) ? await readMxl(await file.arrayBuffer()) : await file.text();
    await loadScore(xmlText, { label: file.name });
  } catch (error) {
    setStatus(`Could not open ${file.name}: ${error.message}`, "outside");
  }
}

// The play buttons replay the notes of the current moment, with the fingers
// that hold them, either as written or one at a time from the bottom up.
const player = new HandPlayer({
  audio,
  press: (midis) => {
    state.replay = new Set(midis);
    return showHands();
  },
  release: () => {
    state.replay = null;
    showHands({ strike: false });
  },
  onChange: (mode) => {
    for (const [name, button] of Object.entries(playButtons)) button.classList.toggle("is-playing", name === mode);
  },
});

function replay(mode) {
  const step = state.steps[state.stepIndex];
  if (!step) return;
  if (player.mode === mode) {
    player.stop();
    return;
  }
  const notes = Object.values(momentAt(step)).flatMap((entry) => entry.sounding);
  // Lift everything first so the fingers strike afresh.
  state.replay = new Set();
  showHands({ strike: false });
  audio.releaseAll();
  player.play(notes, mode);
}

playButtons.together.addEventListener("click", () => replay("together"));
playButtons.succession.addEventListener("click", () => replay("succession"));

soundToggle.checked = audio.enabled;
soundToggle.addEventListener("change", () => {
  audio.setEnabled(soundToggle.checked);
  localStorage.setItem("musichands-sound", soundToggle.checked ? "on" : "off");
});

// Clicking a key plays it; if a finger sits on that key, the finger plays it.
handsStage.addEventListener("noteon", (event) => {
  const midi = Number(event.detail.midi);
  state.clicked.add(midi);
  audio.noteOn(midi);
  showHands({ strike: false });
});
handsStage.addEventListener("noteoff", (event) => {
  const midi = Number(event.detail.midi);
  state.clicked.delete(midi);
  audio.noteOff(midi);
  showHands({ strike: false });
});

scoreSelect.addEventListener("change", () => loadScoreUrl(scoreSelect.value));
scoreFile.addEventListener("change", () => {
  const [file] = scoreFile.files;
  if (file) readScoreFile(file);
});
document.querySelector("#step-first").addEventListener("click", () => goToStep(0));
document.querySelector("#step-prev").addEventListener("click", () => goToStep(state.stepIndex - 1));
document.querySelector("#step-next").addEventListener("click", () => goToStep(state.stepIndex + 1));

window.addEventListener("keydown", (event) => {
  if (event.target.matches("input, select, button, textarea")) return;
  if (event.key === "ArrowRight") goToStep(state.stepIndex + 1);
  else if (event.key === "ArrowLeft") goToStep(state.stepIndex - 1);
  else if (event.key === "Home") goToStep(0);
  else if (event.key === "End") goToStep(state.steps.length - 1);
  else if (event.key === " ") replay(event.shiftKey ? "succession" : "together");
  else return;
  event.preventDefault();
});

document.getElementById("guides-toggle")?.addEventListener("change", (event) => {
  state.showGuides = event.target.checked;
  drawStaffGuides();
});
renderLegend();

window.musichands = state;
loadScoreUrl(scoreSelect.value);
