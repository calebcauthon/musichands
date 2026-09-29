import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseXml, child, text } from "../xml.js";
import { parseScore } from "../score-model.js";
import { noteToMidi } from "../hand-model.js";
import { assignFingering, heuristicFingering } from "../fingering.js";
import { readMxl } from "../mxl.js";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise>
  <work><work-title>Fixture &amp; Friends</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <time><beats>3</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><staff>1</staff>
        <notations><technical><fingering>1</fingering></technical></notations></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><staff>1</staff>
        <notations><technical><fingering>3</fingering></technical></notations></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><staff>1</staff></note>
      <note><rest/><duration>1</duration><staff>1</staff></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><staff>1</staff><tie type="start"/></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>6</duration><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>6</duration><staff>1</staff><tie type="stop"/></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>B</step><alter>-1</alter><octave>2</octave></pitch><duration>6</duration><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

test("xml reader handles doctype, entities, self-closing tags, and attributes", () => {
  const doc = parseXml(FIXTURE);
  const score = child(doc, "score-partwise");
  assert.equal(text(child(score, "work"), "work-title"), "Fixture & Friends");
  assert.equal(child(score, "part").attrs.id, "P1");
});

test("score model groups chords, splits hands by staff, and tracks time", () => {
  const score = parseScore(FIXTURE);
  assert.equal(score.title, "Fixture & Friends");
  assert.equal(score.measures.length, 2);
  assert.equal(score.measures[1].start, 3);

  const [chord, bass, single, tied] = score.events;
  assert.equal(chord.hand, "right");
  assert.deepEqual(chord.notes.map((note) => note.note), ["C4", "E4"]);
  assert.deepEqual(chord.notes.map((note) => note.finger), [1, 3]);
  assert.equal(chord.duration, 1);

  assert.equal(bass.hand, "left");
  assert.equal(bass.notes[0].note, "C3");
  assert.equal(bass.beat, 1);

  assert.equal(single.notes[0].note, "F#4");
  assert.equal(single.beat, 2);
  assert.equal(single.finger, undefined);

  assert.equal(tied.notes[0].note, "G4");
  assert.equal(tied.beat, 3);
  assert.equal(tied.attack, true);

  const continued = score.events.find((event) => event.measure === "2" && event.hand === "right");
  assert.equal(continued.attack, false);
  assert.equal(continued.notes[0].held, true);
  const flat = score.events.find((event) => event.measure === "2" && event.hand === "left");
  assert.equal(flat.notes[0].note, "Bb2");
});

test("heuristic fingering spreads chords like a hand and mirrors the left hand", () => {
  const chord = [
    { note: "C4", midi: 60 },
    { note: "E4", midi: 64 },
    { note: "G4", midi: 67 },
  ];
  assert.deepEqual(heuristicFingering(chord, "right").map((note) => note.finger), [1, 3, 5]);
  assert.deepEqual(heuristicFingering(chord, "left").map((note) => note.finger), [5, 3, 1]);

  const wide = [...chord, { note: "C5", midi: 72 }];
  assert.deepEqual(heuristicFingering(wide, "right").map((note) => note.finger), [1, 2, 3, 5]);

  const fixed = new Map([[64, 2]]);
  assert.deepEqual(heuristicFingering(wide, "right", fixed).map((note) => note.finger), [1, 2, 4, 5]);
  const pinned = new Map([[60, 2]]);
  assert.deepEqual(heuristicFingering(chord, "right", pinned).map((note) => note.finger), [2, 4, 5]);
});

test("fingering prefers the score, then overrides, then the heuristic", () => {
  const score = parseScore(FIXTURE);
  const overrides = { "1:2": { right: { "F#4": 4 } } };
  const { events } = assignFingering(score.events, { overrides });
  assert.equal(events[0].fingeringSource, "score");
  assert.deepEqual(events[0].notes.map((note) => note.finger), [1, 3]);
  assert.equal(events[2].fingeringSource, "override");
  assert.equal(events[2].notes[0].finger, 4);
  assert.equal(events[1].fingeringSource, "heuristic");
  assert.ok(events.every((event) => event.notes.every((note) => note.finger >= 1 && note.finger <= 5)));
});

test("positions group notes that fit under one hand and split when they do not", () => {
  const score = parseScore(FIXTURE);
  const { positions } = assignFingering(score.events);
  assert.equal(positions.right.length, 1);
  assert.deepEqual(
    positions.right[0].fingers,
    [
      { finger: 1, note: "C4" },
      { finger: 3, note: "E4" },
      { finger: 4, note: "F#4" },
      { finger: 5, note: "G4" },
    ],
  );
  assert.equal(positions.right[0].endMeasure, "2");
  assert.deepEqual(positions.right[0].sources.sort(), ["heuristic", "score"]);

  const jump = [
    { hand: "right", measure: "1", beat: 1, time: 0, duration: 1, notes: [{ note: "C4", midi: 60, finger: null }] },
    { hand: "right", measure: "1", beat: 2, time: 1, duration: 1, notes: [{ note: "E4", midi: 64, finger: null }] },
    { hand: "right", measure: "2", beat: 1, time: 4, duration: 1, notes: [{ note: "C6", midi: 84, finger: null }] },
    { hand: "right", measure: "2", beat: 2, time: 5, duration: 1, notes: [{ note: "C4", midi: 60, finger: 5 }] },
    { hand: "right", measure: "2", beat: 3, time: 6, duration: 1, notes: [{ note: "E4", midi: 64, finger: 5 }] },
  ];
  const bass = [
    { hand: "left", measure: "1", beat: 1, time: 0, duration: 1, notes: [{ note: "A1", midi: 33, finger: 5 }] },
    { hand: "left", measure: "1", beat: 2, time: 1, duration: 1, notes: [{ note: "G1", midi: 31, finger: null }] },
  ];
  const stretched = assignFingering(bass);
  assert.equal(stretched.positions.left.length, 2, "a note below a pinned pinky cannot share the position");
  assert.ok(stretched.events.every((event) => event.notes.every((note) => note.finger >= 1 && note.finger <= 5)));

  const split = assignFingering(jump).positions.right;
  assert.deepEqual(split.map((position) => position.startMeasure + ":" + position.startBeat), ["1:1", "2:1", "2:2", "2:3"]);
  assert.deepEqual(split[2].fingers, [{ finger: 5, note: "C4" }]);
});

test("parses the bundled Roundball Rock score end to end", () => {
  const xml = readFileSync(new URL("../scores/roundball-rock.musicxml", import.meta.url), "utf8");
  const score = parseScore(xml);
  assert.equal(score.measures.length, 68);
  assert.ok(score.events.length > 600);
  const { events, positions } = assignFingering(score.events);
  assert.ok(events.every((event) => event.notes.every((note) => note.finger)));
  assert.ok(events.every((event) => new Set(event.notes.map((note) => note.finger)).size === event.notes.length));
  assert.ok(positions.right.length > 5 && positions.right.length < events.length / 3);
  positions.right.forEach((position) => {
    const midis = position.fingers.map((entry) => noteToMidi(entry.note));
    assert.ok(Math.max(...midis) - Math.min(...midis) <= 12);
  });
});

test("reads a compressed .mxl archive", async () => {
  const xml = readFileSync(new URL("../scores/roundball-rock.musicxml", import.meta.url));
  const stored = zipStored("score.musicxml", xml);
  const text = await readMxl(stored);
  assert.equal(parseScore(text).measures.length, 68);
});

// A minimal uncompressed zip writer so the test does not depend on a zip tool.
function zipStored(name, data) {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const crc = crc32(data);
  const local = new Uint8Array(30 + nameBytes.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint32(14, crc, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint32(16, crc, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  const centralOffset = local.length + data.length;
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, centralOffset, true);
  const out = new Uint8Array(centralOffset + central.length + end.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(central, centralOffset);
  out.set(end, centralOffset + central.length);
  return out.buffer;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
