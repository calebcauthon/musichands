// The agent's own passage becomes a sheet: MusicXML the page reads like any
// score, with each note's finger, and the resting fingers at each moment so
// the hand sits where the agent said; what a hand cannot do is a plain error.
import assert from "node:assert/strict";
import test from "node:test";
import { assignFingering } from "../fingering.js";
import { writeSheet } from "../freehand.js";
import { parseScore } from "../score-model.js";

const key = (finger, note) => ({ finger, note });
const scale = ["C4", "D4", "E4", "F4", "G4"].map((note, index) => ({ keys: [key(index + 1, note)], beats: 1 }));
const moments = (events, hand) => events.filter((event) => event.hand === hand).map((event) => `${event.measure}:${event.beat} ${event.notes.map((note) => `${note.finger}${note.note}${note.held ? "~" : ""}`).join("+")}`);

test("a sheet is MusicXML the score reader takes back, finger by finger, in measures of the beats given", () => {
  const sheet = writeSheet({ title: "C to G", tempo: 90, right: { notes: scale } });
  assert.equal(sheet.error, undefined);
  assert.equal(sheet.title, "C to G");
  assert.equal(sheet.measures, 2);
  assert.deepEqual(sheet.rests, {});
  const score = parseScore(sheet.xml);
  assert.equal(score.title, "C to G");
  assert.equal(score.tempo, 90);
  assert.deepEqual(moments(score.events, "right"), ["1:1 1C4", "1:2 2D4", "1:3 3E4", "1:4 4F4", "2:1 5G4"]);
  assert.deepEqual(moments(score.events, "left"), [], "a hand with no notes rests");
  const waltz = writeSheet({ title: "Three", beats_per_measure: 3, left: { notes: [{ keys: [key(5, "C3"), key(1, "G3")], beats: 3 }, { keys: [key(3, "E3")], beats: 1 }] } });
  assert.equal(waltz.measures, 2);
  assert.deepEqual(moments(parseScore(waltz.xml).events, "left"), ["1:1 5C3+1G3", "2:1 3E3"]);
});

test("a run under one hand is fingered as one position, so every pose has the whole hand on its keys", () => {
  const sheet = writeSheet({ title: "Run", right: { notes: scale } });
  const { positions } = assignFingering(parseScore(sheet.xml).events);
  assert.deepEqual(
    positions.right.map((position) => position.fingers),
    [[key(1, "C4"), key(2, "D4"), key(3, "E4"), key(4, "F4"), key(5, "G4")]],
  );
});

test("a position puts the resting fingers where the agent says, at every moment it holds, even when one finger plays", () => {
  const sheet = writeSheet({ title: "One note", right: { position: [key(1, "C4"), key(2, "D4"), key(3, "E4"), key(4, "F4"), key(5, "G4")], notes: [{ keys: [key(3, "E4")], beats: 2 }, { keys: [key(1, "C4")], beats: 2 }] } });
  assert.deepEqual(sheet.rests, {
    "1:1": { right: [key(1, "C4"), key(2, "D4"), key(4, "F4"), key(5, "G4")] },
    "1:3": { right: [key(2, "D4"), key(3, "E4"), key(4, "F4"), key(5, "G4")] },
  });
  const { positions } = assignFingering(parseScore(sheet.xml).events, { rests: sheet.rests });
  assert.deepEqual(positions.right.map((position) => position.fingers), [[key(1, "C4"), key(2, "D4"), key(3, "E4"), key(4, "F4"), key(5, "G4")]]);
  // A struck key wins over a resting finger on it, and the resting fingers follow a note tied over a barline.
  const shifted = writeSheet({ title: "Shift", left: { position: [key(1, "G3"), key(5, "C3")], notes: [{ keys: [key(1, "A3")], beats: 5 }] } });
  assert.deepEqual(shifted.rests, { "1:1": { left: [key(5, "C3")] }, "2:1": { left: [key(5, "C3")] } });
});

test("a position changes from the note that gives a new one", () => {
  const sheet = writeSheet({ title: "Two positions", right: { position: [key(1, "C4"), key(3, "E4")], notes: [{ keys: [key(1, "C4")], beats: 1 }, { keys: [key(1, "F4")], beats: 1, position: [key(1, "F4"), key(5, "C5")] }] } });
  assert.deepEqual(sheet.rests, { "1:1": { right: [key(3, "E4")] }, "1:2": { right: [key(5, "C5")] } });
});

test("the beats: notes follow on, 'at' places one later and leaves a rest, a note lasts at most until the next, both hands keep their own time", () => {
  const sheet = writeSheet({
    title: "Timing",
    right: { notes: [{ keys: [key(1, "C4")], beats: 1 }, { keys: [key(3, "E4")], beats: 1, at: 3 }] },
    left: { notes: [{ keys: [key(5, "C3"), key(1, "G3")], beats: 4 }] },
  });
  const score = parseScore(sheet.xml);
  assert.deepEqual(moments(score.events, "right"), ["1:1 1C4", "1:3 3E4"]);
  assert.deepEqual(moments(score.events, "left"), ["1:1 5C3+1G3"]);
  assert.equal(score.events.find((event) => event.hand === "left").duration, 4);
  const clipped = writeSheet({ title: "Clip", right: { notes: [{ keys: [key(1, "C4")], beats: 4 }, { keys: [key(2, "D4")], beats: 1, at: 2 }] } });
  assert.equal(parseScore(clipped.xml).events[0].duration, 1);
});

test("what cannot be is an error that says where and why", () => {
  const error = (args) => writeSheet({ title: "T", ...args }).error;
  assert.match(writeSheet({ right: { notes: scale } }).error, /Give the sheet a title/);
  assert.match(error({}), /No notes to write/);
  assert.match(error({ beats_per_measure: 5, right: { notes: scale } }), /beats_per_measure must be one of/);
  assert.match(error({ right: { notes: [{ keys: [key(6, "C4")], beats: 1 }] } }), /right hand, note 1: finger 6 on C4 is not a finger/);
  assert.match(error({ right: { notes: [{ keys: [key(1, "E4"), key(2, "C4")], beats: 1 }] } }), /note 1: thumb on E4 with pointer on C4 puts the fingers out of order for the right hand/);
  assert.match(error({ left: { notes: [{ keys: [key(1, "C3"), key(5, "G3")], beats: 1 }] } }), /out of order for the left hand/);
  assert.match(error({ right: { position: [key(1, "C4"), key(5, "G5")], notes: scale } }), /position: thumb on C4 to pinky on G5 is more than a hand can stretch/);
  assert.match(error({ right: { notes: [{ keys: [key(1, "C4")], beats: 1 }, { keys: [key(2, "D4")], beats: 1, at: 1 }] } }), /two things begin on beat 1; make them one chord/);
  // A position the notes then break: the hand is told to be given a new one from that note.
  assert.match(error({ right: { position: [key(1, "C4"), key(2, "D4"), key(3, "E4")], notes: [{ keys: [key(1, "C4")], beats: 1 }, { keys: [key(1, "F4")], beats: 1 }] } }), /right hand, 1:2: .*out of order.*; give the hand a new position from that note/);
  assert.match(error({ right: { notes: [{ keys: [key(1, "C4")], beats: 1, at: 0 }] } }), /"at" is the beat it begins on/);
});
