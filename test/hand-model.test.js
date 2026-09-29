import test from "node:test";
import assert from "node:assert/strict";

import {
  getKeyboardWindow,
  isBlackNote,
  midiToNote,
  normalizeNote,
  noteToMidi,
} from "../hand-model.js";
import { createHandKeyboardSvg } from "../hand-keyboard.js";

test("normalizes flats and preserves octave", () => {
  assert.equal(normalizeNote("Db4"), "C#4");
  assert.equal(normalizeNote("Cb4"), "B3");
});

test("converts notes to MIDI and back", () => {
  assert.equal(noteToMidi("C4"), 60);
  assert.equal(noteToMidi("F#4"), 66);
  assert.equal(midiToNote(69), "A4");
});

test("recognizes black notes", () => {
  assert.equal(isBlackNote("Bb3"), true);
  assert.equal(isBlackNote("E4"), false);
});

test("keyboard window contains every assigned finger note with padding", () => {
  const fingers = ["C4", "E4", "G4", "B4", "C5"].map((note, index) => ({ finger: index + 1, note }));
  const window = getKeyboardWindow(fingers);
  const midis = window.map((entry) => entry.midi);
  assert.ok(window.length >= 12);
  assert.ok(Math.min(...midis) < noteToMidi("C4"));
  assert.ok(Math.max(...midis) > noteToMidi("C5"));
});

test("standalone SVG contains its drawing styles and assigned notes", () => {
  const fingers = ["C4", "D4", "E4", "F4", "G4"].map((note, index) => ({ finger: index + 1, note }));
  const svg = createHandKeyboardSvg({ hand: "right", fingers });
  assert.match(svg, /<svg[^>]+viewBox="0 0 1040 520"/);
  assert.match(svg, /<style>/);
  assert.match(svg, /data-note="C4"/);
  assert.match(svg, /RIGHT HAND/);
  assert.match(svg, /class="fingernail"/);
  assert.match(svg, /class="finger-badge"/);
  assert.equal((svg.match(/class="finger-fill"/g) ?? []).length, 5);
});
