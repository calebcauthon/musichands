// MusicXML written here is read back by the score reader as the same music:
// chords, fingers, rests in the gaps, notes tied over the barline and split
// into values the notation can show.
import assert from "node:assert/strict";
import test from "node:test";
import { parseScore } from "../score-model.js";
import { writeScore } from "../score-writer.js";

const note = (name, finger) => ({ note: name, finger });

test("notes, chords and fingers come back as written, in measures of the beats asked for", () => {
  const xml = writeScore({
    title: "A test",
    tempo: 72,
    beatsPerMeasure: 3,
    parts: { right: [{ time: 0, duration: 1, notes: [note("C4", 1)] }, { time: 1, duration: 2, notes: [note("E4", 3), note("G4", 5)] }], left: [{ time: 0, duration: 3, notes: [note("C3", 5)] }] },
  });
  const score = parseScore(xml);
  assert.equal(score.title, "A test");
  assert.equal(score.tempo, 72);
  assert.equal(score.measures.length, 1);
  assert.deepEqual(score.measures[0].beats, 3);
  assert.deepEqual(
    score.events.map((event) => [event.hand, event.time, event.duration, event.notes.map((entry) => `${entry.finger}${entry.note}`)]),
    [
      ["right", 0, 1, ["1C4"]],
      ["left", 0, 3, ["5C3"]],
      ["right", 1, 2, ["3E4", "5G4"]],
    ],
  );
});

test("a note over the barline is tied: one attack, held into the next measure for its whole length", () => {
  const xml = writeScore({ parts: { right: [{ time: 3, duration: 2, notes: [note("F#4", 2)] }] } });
  const score = parseScore(xml);
  assert.equal(score.measures.length, 2);
  const [first, second] = score.events;
  assert.equal(first.time, 3);
  assert.equal(first.attack, true);
  assert.equal(first.notes[0].sustain, 2, "it rings for its whole length");
  assert.equal(second.time, 4);
  assert.equal(second.attack, false);
  assert.equal(second.notes[0].held, true);
  assert.match(xml, /<accidental>sharp<\/accidental>/);
});

test("odd lengths are split into values the notation shows, tied; gaps are rests; an empty staff rests the measure", () => {
  const xml = writeScore({ parts: { left: [{ time: 0.5, duration: 2.5, notes: [note("G2", 5)] }] } });
  assert.match(xml, /<rest\/><duration>2<\/duration><voice>2<\/voice><type>eighth<\/type>/, "an eighth rest before it");
  assert.match(xml, /<type>half<\/type>.*<tied type="start"\/>/, "a half tied to");
  assert.match(xml, /<tied type="stop"\/>/);
  assert.match(xml, /<rest measure="yes"\/><duration>16<\/duration><voice>1<\/voice>/, "the right hand's whole measure rests");
  assert.match(writeScore({ parts: { right: [{ time: 0, duration: 1.5, notes: [note("C4", 1)] }] } }), /<type>quarter<\/type><dot\/>/, "a dotted value when one fits");
  const score = parseScore(xml);
  assert.equal(score.events[0].time, 0.5);
  assert.equal(score.events[0].notes[0].sustain, 2.5, "one note, however it is written");
  assert.deepEqual(score.events.slice(1).map((event) => event.attack), [false], "the tied piece is held, not struck again");
});
