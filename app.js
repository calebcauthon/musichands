import { createHandView } from "./hand-view.js";
import { describePosition, midiToNote, noteOptions, noteToMidi } from "./hand-model.js";

const PRESETS = {
  "c-position": {
    right: ["C4", "D4", "E4", "F4", "G4"],
    left: ["G3", "F3", "E3", "D3", "C3"],
  },
  "c-chord": {
    right: ["C4", "D4", "E4", "F4", "G4"],
    left: ["G3", "F3", "E3", "D3", "C3"],
  },
  "g-position": {
    right: ["G4", "A4", "B4", "C5", "D5"],
    left: ["D4", "C4", "B3", "A3", "G3"],
  },
  "d-position": {
    right: ["D4", "E4", "F#4", "G4", "A4"],
    left: ["A3", "G3", "F#3", "E3", "D3"],
  },
  "wide-chord": {
    right: ["C4", "E4", "G4", "B4", "C5"],
    left: ["C4", "A3", "G3", "E3", "C3"],
  },
};

const state = {
  hand: "right",
  fingers: [],
  activeMidis: new Set(),
  palmHeight: 44,
  curve: 52,
  weight: 30,
  showNotes: true,
  showGuides: true,
};

const visualStage = document.querySelector("#visual-stage");
const fingerControls = document.querySelector("#finger-controls");
const presetSelect = document.querySelector("#preset-select");
const positionKicker = document.querySelector("#position-kicker");
const positionTitle = document.querySelector("#position-title");
const liveStatus = document.querySelector("#live-status");
const statusText = document.querySelector("#status-text");
const midiButton = document.querySelector("#midi-button");
const downloadButton = document.querySelector("#download-button");
const options = noteOptions(36, 84);

function fingerAssignments(notes) {
  return notes.map((note, index) => ({ finger: index + 1, note }));
}

state.fingers = fingerAssignments(PRESETS["c-position"].right);

const visual = await createHandView(visualStage, { interactive: true, minWidth: 0.44 });

function renderFingerControls() {
  fingerControls.innerHTML = "";
  state.fingers.forEach((finger) => {
    const label = document.createElement("label");
    label.className = `finger-row finger-row--${finger.finger}`;
    label.innerHTML = `
      <span class="finger-token">${finger.finger}</span>
      <span class="finger-name">${finger.finger === 1 ? "Thumb" : finger.finger === 5 ? "Pinky" : `Finger ${finger.finger}`}</span>
      <select aria-label="Note for finger ${finger.finger}">
        ${options.map((note) => `<option value="${note}" ${note === finger.note ? "selected" : ""}>${note}</option>`).join("")}
      </select>`;
    label.querySelector("select").addEventListener("change", (event) => {
      finger.note = event.target.value;
      updateVisual();
    });
    fingerControls.append(label);
  });
}

// Notes under a finger press that finger down; any other note just sounds its key.
function showHand({ immediate = false } = {}) {
  const assigned = new Set(state.fingers.map((finger) => noteToMidi(finger.note)));
  const hand = { fingers: state.fingers, activeMidis: [...state.activeMidis].filter((midi) => assigned.has(midi)), strike: false };
  visual.setHands({ [state.hand]: hand }, { immediate });
  visual.setSounding(state.activeMidis);
}

function updateVisual(options) {
  visual.setOptions(state);
  showHand(options);
  positionKicker.textContent = `${state.hand === "right" ? "Right" : "Left"} hand position`;
  positionTitle.textContent = describePosition(state.hand, state.fingers);
}

function applyPreset(name) {
  state.fingers = fingerAssignments(PRESETS[name][state.hand]);
  state.activeMidis.clear();
  renderFingerControls();
  updateVisual();
}

function setStatus(message, stateName = "idle") {
  statusText.textContent = message;
  liveStatus.dataset.state = stateName;
}

function noteOn(midi, source = "input") {
  state.activeMidis.add(Number(midi));
  showHand();
  const finger = state.fingers.find((entry) => noteToMidi(entry.note) === Number(midi));
  setStatus(
    finger ? `${midiToNote(midi)} · finger ${finger.finger}` : `${midiToNote(midi)} · outside this position`,
    finger ? "correct" : "outside",
  );
  visualStage.dataset.source = source;
}

function noteOff(midi) {
  state.activeMidis.delete(Number(midi));
  showHand();
  if (state.activeMidis.size === 0) setStatus("Ready to play");
}

document.querySelectorAll("[data-hand]").forEach((button) => {
  button.addEventListener("click", () => {
    state.hand = button.dataset.hand;
    document.querySelectorAll("[data-hand]").forEach((candidate) => {
      candidate.classList.toggle("is-active", candidate === button);
    });
    applyPreset(presetSelect.value);
  });
});

presetSelect.addEventListener("change", () => applyPreset(presetSelect.value));

[
  ["palm-height", "palmHeight", "palm-height-output"],
  ["curve", "curve", "curve-output"],
  ["weight", "weight", "weight-output"],
].forEach(([inputId, stateKey, outputId]) => {
  const input = document.querySelector(`#${inputId}`);
  const output = document.querySelector(`#${outputId}`);
  input.addEventListener("input", () => {
    state[stateKey] = Number(input.value);
    output.value = input.value;
    updateVisual();
  });
});

document.querySelector("#show-notes").addEventListener("change", (event) => {
  state.showNotes = event.target.checked;
  updateVisual();
});

document.querySelector("#show-guides").addEventListener("change", (event) => {
  state.showGuides = event.target.checked;
  updateVisual();
});

visualStage.addEventListener("noteon", (event) => noteOn(event.detail.midi, event.detail.source));
visualStage.addEventListener("noteoff", (event) => noteOff(event.detail.midi));

const keyMap = ["a", "w", "s", "e", "d", "f", "t", "g", "y", "h", "u", "j", "k"];
const heldKeys = new Map();

window.addEventListener("keydown", (event) => {
  if (event.repeat || event.target.matches("input, select, button, summary")) return;
  const index = keyMap.indexOf(event.key.toLowerCase());
  if (index === -1) return;
  const rootMidi = Math.min(...state.fingers.map((finger) => noteToMidi(finger.note)));
  const midi = rootMidi + index;
  heldKeys.set(event.key.toLowerCase(), midi);
  noteOn(midi, "computer keyboard");
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (!heldKeys.has(key)) return;
  noteOff(heldKeys.get(key));
  heldKeys.delete(key);
});

async function connectMidi() {
  if (!("requestMIDIAccess" in navigator)) {
    setStatus("Web MIDI is not supported in this browser", "outside");
    return;
  }

  try {
    const midiAccess = await navigator.requestMIDIAccess();
    const inputs = [...midiAccess.inputs.values()];
    if (inputs.length === 0) {
      setStatus("No MIDI keyboard found", "outside");
      return;
    }
    inputs.forEach((input) => {
      input.onmidimessage = ({ data }) => {
        const [command, note, velocity] = data;
        const type = command & 0xf0;
        if (type === 0x90 && velocity > 0) noteOn(note, "MIDI");
        if (type === 0x80 || (type === 0x90 && velocity === 0)) noteOff(note);
      };
    });
    midiButton.textContent = `MIDI connected · ${inputs.length}`;
    midiButton.classList.add("is-connected");
    setStatus(`Listening to ${inputs[0].name || "MIDI keyboard"}`, "connected");
  } catch (error) {
    setStatus("MIDI connection was not allowed", "outside");
  }
}

midiButton.addEventListener("click", connectMidi);

downloadButton.addEventListener("click", () => {
  const file = visual.download(`musichands-${state.hand}-position`);
  const link = document.createElement("a");
  link.href = file.href;
  link.download = file.download;
  document.body.append(link);
  link.click();
  link.remove();
  if (file.revoke) window.setTimeout(() => URL.revokeObjectURL(file.href), 1000);
});

renderFingerControls();
updateVisual({ immediate: true });

