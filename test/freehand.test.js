// The agent's freehand passage becomes whole-hand poses: a run under one hand
// holds one position, a given position places the resting fingers, only the
// hands named play, and what a hand cannot do comes back as a plain error.
import assert from "node:assert/strict";
import test from "node:test";
import { freehandSteps } from "../freehand.js";

const key = (finger, note) => ({ finger, note });
const scale = ["C4", "D4", "E4", "F4", "G4"].map((note, index) => ({ keys: [key(index + 1, note)], beats: 1 }));

test("a five-finger run is one steady position: every pose has the whole hand on the same keys", () => {
  const run = freehandSteps({ tempo: 120, hands: "right", right: { notes: scale } });
  assert.equal(run.error, undefined);
  assert.equal(run.hands, "right");
  const presses = run.steps.filter((step) => step.right?.press.length);
  assert.equal(presses.length, 5);
  const whole = [key(1, "C4"), key(2, "D4"), key(3, "E4"), key(4, "F4"), key(5, "G4")];
  for (const step of presses) assert.deepEqual(step.right.fingers, whole);
  assert.deepEqual(presses.map((step) => step.ms), [0, 500, 1000, 1500, 2000]);
  assert.deepEqual(presses.map((step) => step.right.press), [["C4"], ["D4"], ["E4"], ["F4"], ["G4"]]);
  assert.equal(presses[0].right.hold, 500);
  // The last step lifts the hand where it sits.
  assert.deepEqual(run.steps.at(-1), { ms: 2500, right: { fingers: whole, press: [] } });
});

test("a position puts the resting fingers where the agent says, even when one finger plays", () => {
  const run = freehandSteps({ tempo: 60, hands: "right", right: { position: [key(1, "C4"), key(2, "D4"), key(3, "E4"), key(4, "F4"), key(5, "G4")], notes: [{ keys: [key(3, "E4")], beats: 2 }] } });
  assert.deepEqual(run.steps[0].right, { fingers: [key(1, "C4"), key(2, "D4"), key(3, "E4"), key(4, "F4"), key(5, "G4")], press: ["E4"], hold: 2000 });
  // A struck key wins over a resting finger on it; a finger left out of the position sits over the key it plays in the run.
  const shifted = freehandSteps({ tempo: 60, hands: "left", left: { position: [key(1, "G3"), key(5, "C3")], notes: [{ keys: [key(1, "A3")], beats: 1 }, { keys: [key(3, "E3")], beats: 1 }] } });
  assert.deepEqual(shifted.steps[0].left.fingers, [key(1, "A3"), key(3, "E3"), key(5, "C3")]);
  assert.deepEqual(shifted.steps[1].left.fingers, [key(1, "G3"), key(3, "E3"), key(5, "C3")]);
});

test("a position changes from the note that gives a new one", () => {
  const run = freehandSteps({
    tempo: 60,
    hands: "right",
    right: { position: [key(1, "C4"), key(3, "E4")], notes: [{ keys: [key(1, "C4")], beats: 1 }, { keys: [key(1, "F4")], beats: 1, position: [key(1, "F4"), key(5, "C5")] }] },
  });
  assert.deepEqual(run.steps[0].right.fingers, [key(1, "C4"), key(3, "E4")]);
  assert.deepEqual(run.steps[1].right.fingers, [key(1, "F4"), key(5, "C5")]);
});

test("the beats: notes follow on, 'at' places one later and leaves a rest, both hands keep their own time", () => {
  const run = freehandSteps({
    tempo: 120,
    hands: "both",
    right: { notes: [{ keys: [key(1, "C4")], beats: 1 }, { keys: [key(3, "E4")], beats: 1, at: 3 }] },
    left: { notes: [{ keys: [key(5, "C3"), key(1, "G3")], beats: 4 }] },
  });
  assert.deepEqual(
    run.steps.map((step) => [step.ms, step.right?.press ?? null, step.left?.press ?? null]),
    [
      [0, ["C4"], ["C3", "G3"]],
      [500, [], null], // the right hand lifts for its rest; the left plays on
      [1000, ["E4"], null],
      [1500, [], null],
      [2000, null, []],
    ],
  );
  assert.equal(run.steps[0].left.hold, 2000);
  // A note lasts at most until the next one of its hand begins.
  const clipped = freehandSteps({ tempo: 60, hands: "right", right: { notes: [{ keys: [key(1, "C4")], beats: 4 }, { keys: [key(2, "D4")], beats: 1, at: 2 }] } });
  assert.equal(clipped.steps[0].right.hold, 1000);
});

test("what cannot be is an error that says where and why", () => {
  const error = (args) => freehandSteps(args).error;
  assert.match(error({ tempo: 60, hands: "right", left: { notes: scale } }), /left hand has notes, but hands is "right"/);
  assert.match(error({ tempo: 60, hands: "right" }), /No notes to play/);
  assert.match(error({ tempo: 60, hands: "nope", right: { notes: scale } }), /hands must be/);
  assert.match(error({ tempo: 60, hands: "right", right: { notes: [{ keys: [key(6, "C4")], beats: 1 }] } }), /right hand, note 1: finger 6 on C4 is not a finger/);
  assert.match(error({ tempo: 60, hands: "right", right: { notes: [{ keys: [key(1, "E4"), key(2, "C4")], beats: 1 }] } }), /note 1: thumb on E4 with pointer on C4 puts the fingers out of order for the right hand/);
  assert.match(error({ tempo: 60, hands: "left", left: { notes: [{ keys: [key(1, "C3"), key(5, "G3")], beats: 1 }] } }), /out of order for the left hand/);
  assert.match(error({ tempo: 60, hands: "right", right: { position: [key(1, "C4"), key(5, "G5")], notes: scale } }), /position: thumb on C4 to pinky on G5 is more than a hand can stretch/);
  assert.match(error({ tempo: 60, hands: "right", right: { notes: [{ keys: [key(1, "C4")], beats: 1 }, { keys: [key(2, "D4")], beats: 1, at: 1 }] } }), /two things begin on beat 1; make them one chord/);
  // A position the notes then break: the hand is told to be given a new one from that note.
  assert.match(error({ tempo: 60, hands: "right", right: { position: [key(1, "C4"), key(2, "D4"), key(3, "E4")], notes: [{ keys: [key(1, "C4")], beats: 1 }, { keys: [key(1, "F4")], beats: 1 }] } }), /beat 2: .*out of order.*; give the hand a new position from that note/);
  assert.match(error({ tempo: 60, hands: "right", right: { notes: [{ keys: [key(1, "C4")], beats: 1, at: 0 }] } }), /"at" is the beat it begins on/);
});
