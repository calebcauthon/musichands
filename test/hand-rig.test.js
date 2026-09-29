import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FINGER_JOINTS, readSkeleton } from "../glb-skeleton.js";
import { noteToMidi } from "../hand-model.js";
import { blendPose, createRig, poseMatrices, restPose, solvePose } from "../hand-rig.js";
import { KEYBOARD, keyCenterAt, keyFor, surfaceHeight } from "../piano-geometry.js";
import { mat4, vec3 } from "../rig-math.js";

const file = await readFile(new URL("../assets/hand-right.glb", import.meta.url));
const rig = createRig(readSkeleton(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)));

const targetsFor = (list) => list.map(([note, finger, state = "rest"]) => ({ finger, key: keyFor(noteToMidi(note)), state }));

// Length of every bone in a posed hand, in metres.
function boneLengths(pose, scale = 1) {
  const { joints } = poseMatrices(rig, pose, scale);
  const lengths = {};
  for (const names of Object.values(FINGER_JOINTS)) {
    for (let index = 1; index < names.length; index += 1) {
      lengths[names[index]] = vec3.distance(mat4.position(joints[names[index - 1]]), mat4.position(joints[names[index]]));
    }
  }
  return lengths;
}

const CHORDS = {
  "five-finger C": [["C4", 1], ["D4", 2], ["E4", 3], ["F4", 4], ["G4", 5]],
  "octave with inner notes": [["A3", 1], ["C4", 2], ["E4", 3], ["A4", 5]],
  "ninth": [["F4", 1], ["B4", 2], ["C5", 3], ["D5", 4], ["G5", 5]],
  "black-key chord": [["F#4", 1], ["A4", 3], ["C#5", 5]],
  "thumb alone": [["G4", 1]],
  "pinky alone": [["B4", 5]],
};

test("the skeleton has every joint and real proportions", () => {
  for (const names of Object.values(FINGER_JOINTS)) {
    for (const name of names) assert.ok(rig.rest[name], `missing ${name}`);
  }
  const lengths = boneLengths(restPose());
  const reach = (finger) => FINGER_JOINTS[finger].slice(2).reduce((total, name) => total + lengths[name], 0);
  assert.ok(reach(3) > reach(2) && reach(3) > reach(4), "the middle finger is the longest");
  assert.ok(reach(5) < reach(4), "the pinky is shorter than the ring finger");
  assert.ok(reach(1) < reach(5), "the thumb's two free bones are shorter than the pinky");
});

test("bones keep their length in every pose", () => {
  const rest = boneLengths(restPose());
  for (const [name, chord] of Object.entries(CHORDS)) {
    const solved = solvePose(rig, targetsFor(chord));
    const posed = boneLengths(solved.pose);
    for (const [bone, length] of Object.entries(rest)) {
      assert.ok(Math.abs(posed[bone] - length) < 1e-9, `${bone} changed length in ${name}`);
    }
  }
});

test("bones keep their length while the hand moves between positions", () => {
  const from = solvePose(rig, targetsFor(CHORDS["five-finger C"]));
  const to = solvePose(rig, targetsFor(CHORDS["octave with inner notes"]));
  const rest = boneLengths(restPose());
  for (const t of [0.1, 0.35, 0.5, 0.8]) {
    const between = blendPose(from, to, t);
    const posed = boneLengths(between.pose);
    for (const [bone, length] of Object.entries(rest)) {
      assert.ok(Math.abs(posed[bone] - length) < 1e-9, `${bone} changed length at t=${t}`);
    }
  }
});

test("every assigned fingertip rests on its key", () => {
  for (const [name, chord] of Object.entries(CHORDS)) {
    const solved = solvePose(rig, targetsFor(chord));
    assert.ok(solved.error < 0.001, `${name} misses by ${(solved.error * 1000).toFixed(2)} mm`);
    const { balls } = poseMatrices(rig, solved.pose, solved.scale);
    for (const [note, finger] of chord) {
      const key = keyFor(noteToMidi(note));
      const ball = balls[finger];
      const radius = rig.fingers[finger].radius * solved.scale;
      assert.ok(Math.abs(ball[0] - keyCenterAt(key, ball[2])) < key.xMax - key.x, `${name}: finger ${finger} is off ${note} sideways`);
      assert.ok(Math.abs(ball[1] - radius - key.top) < 0.001, `${name}: finger ${finger} is not touching ${note}`);
      assert.ok(ball[2] < key.zFront && ball[2] > key.zBack, `${name}: finger ${finger} is off the end of ${note}`);
    }
  }
});

test("idle fingers hover above the keys instead of sinking into them", () => {
  const solved = solvePose(rig, targetsFor(CHORDS["thumb alone"]));
  const { balls } = poseMatrices(rig, solved.pose, solved.scale);
  for (const finger of [2, 3, 4, 5]) {
    const ball = balls[finger];
    const floor = surfaceHeight(ball[0], ball[2]);
    assert.ok(ball[1] - rig.fingers[finger].radius > floor, `finger ${finger} sinks into the keyboard`);
  }
});

test("a pressed key takes the finger down with it, and a lifted finger rises", () => {
  const chord = CHORDS["five-finger C"];
  const base = solvePose(rig, targetsFor(chord));
  const height = (solved) => poseMatrices(rig, solved.pose, solved.scale).balls[3][1];
  const pressed = solvePose(rig, targetsFor(chord.map(([note, finger]) => [note, finger, finger === 3 ? "pressed" : "rest"])), { from: base });
  const lifted = solvePose(rig, targetsFor(chord.map(([note, finger]) => [note, finger, finger === 3 ? "lifted" : "rest"])), { from: base });
  assert.ok(height(pressed) < height(base) - 0.004);
  assert.ok(height(lifted) > height(base) + 0.006);
  assert.deepEqual(pressed.pose.slice(0, 6), base.pose.slice(0, 6), "the hand itself stays put while one finger plays");
});

test("a span too wide for the hand grows the hand, not the fingers", () => {
  const solved = solvePose(rig, targetsFor([["C4", 1], ["G5", 5]]));
  assert.ok(solved.scale > 1);
  const rest = boneLengths(restPose(), solved.scale);
  const posed = boneLengths(solved.pose, solved.scale);
  for (const [bone, length] of Object.entries(rest)) assert.ok(Math.abs(posed[bone] - length) < 1e-9, bone);
});

test("the keyboard is laid out like a real piano", () => {
  const middleC = keyFor(60);
  const nextC = keyFor(72);
  assert.ok(Math.abs(nextC.x - middleC.x - 7 * KEYBOARD.whiteWidth) < 1e-9, "an octave is seven white keys wide");
  const cSharp = keyFor(61);
  assert.ok(cSharp.black && cSharp.x > middleC.x && cSharp.x < keyFor(62).x);
  assert.equal(surfaceHeight(cSharp.x, -0.1), KEYBOARD.blackRise);
  assert.equal(surfaceHeight(middleC.x - 0.004, -0.02), 0);
  // Between the black keys a white key only shows a strip, pushed away from its black neighbour.
  assert.ok(keyCenterAt(middleC, -0.1) < middleC.x);
  assert.throws(() => keyFor(10));
});
