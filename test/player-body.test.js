import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readSkeleton } from "../glb-skeleton.js";
import { noteToMidi } from "../hand-model.js";
import { createRig, describePose, lapPose, solvePose } from "../hand-rig.js";
import { keyFor } from "../piano-geometry.js";
import { BODY, ELBOW_SWING, elbowPoint, forearmDirection, leanFor, seatPlayer, shoulderPoint } from "../player-body.js";
import { vec3 } from "../rig-math.js";

const file = await readFile(new URL("../assets/hand-right.glb", import.meta.url));
const rig = createRig(readSkeleton(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)));

const DEG = Math.PI / 180;
const SIDES = ["left", "right"];
// A wrist over the keys, where a hand playing at `x` along the keyboard holds it.
const wristAt = (x) => [x, 0.06, 0.095];
const ends = { low: keyFor(21).x, high: keyFor(108).x };
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) < tolerance;
// The direction a hand points across the keyboard, as the solver's yaw: positive turns the fingers toward the bass.
const heading = (direction) => Math.atan2(-direction[0], -direction[2]) / DEG;

test("the player sits at the middle of the keyboard with a shoulder either side", () => {
  const left = shoulderPoint("left");
  const right = shoulderPoint("right");
  assert.ok(near(left[0], -right[0]) && near(left[1], right[1]) && near(left[2], right[2]), "the shoulders mirror each other");
  assert.ok(near((ends.low + ends.high) / 2, (left[0] + right[0]) / 2, 0.02), "the player is centred on the keyboard");
  assert.ok(near(right[0] - left[0], BODY.shoulder * 2), "the shoulders are a body's width apart");
  assert.ok(right[1] > 0.25 && right[1] < 0.45, "the shoulders are above the keys");
  assert.ok(right[2] > 0.3, "the player sits back from the keys");
  assert.ok(BODY.hip[1] > BODY.bench.top && BODY.bench.top > BODY.floor, "the hips are on the bench and the bench is on the floor");
});

test("arm bones keep their length wherever the hands go", () => {
  // From each hand past its own end of the keyboard to both hands crossed over the middle.
  for (let x = ends.low - 0.05; x <= 0.2; x += 0.05) {
    for (const swing of [ELBOW_SWING[0], 0, ELBOW_SWING[1]]) {
      const { arms } = seatPlayer({ left: wristAt(x), right: wristAt(-x) }, { left: swing, right: swing });
      for (const side of SIDES) {
        const { shoulder, elbow, wrist } = arms[side];
        assert.ok(near(vec3.distance(shoulder, elbow), BODY.upperArm, 1e-6), `${side} upper arm at ${x.toFixed(2)}`);
        assert.ok(near(vec3.distance(elbow, wrist), BODY.forearm, 1e-6), `${side} forearm at ${x.toFixed(2)}`);
      }
    }
  }
});

test("the seat stays put: nothing leans while the keys are within reach", () => {
  const lean = leanFor({ left: wristAt(-0.2), right: wristAt(0.2) });
  assert.deepEqual(lean, { side: 0, forward: 0 });
  assert.deepEqual(seatPlayer({ left: wristAt(-0.35), right: wristAt(0.4) }).arms.right.shoulder, shoulderPoint("right"));
});

test("a key beyond arm's reach leans the torso from the hips toward it", () => {
  const limit = (BODY.upperArm + BODY.forearm) * BODY.reach;
  const top = wristAt(ends.high);
  assert.ok(vec3.distance(shoulderPoint("right"), top) > limit, "the top key is out of reach sitting upright");
  const { lean, arms } = seatPlayer({ right: top });
  assert.ok(lean.side > 2 * DEG && lean.side <= BODY.lean.side, "the torso leans to the right");
  assert.ok(vec3.distance(arms.right.shoulder, top) < limit + 1e-3, "leaning brings the key within reach");
  assert.ok(arms.right.shoulder[0] > shoulderPoint("right")[0], "the shoulder goes with the torso");
  assert.ok(leanFor({ left: wristAt(ends.low) }).side < -2 * DEG, "and to the left for the bottom key");
  // Both ends at once can only be met by leaning in.
  const both = leanFor({ left: wristAt(ends.low), right: wristAt(ends.high) });
  assert.ok(Math.abs(both.side) < 1 * DEG && both.forward > 5 * DEG);
});

test("the elbow hangs below and outside the line from shoulder to wrist", () => {
  for (const x of [-0.1, 0.1, 0.3, 0.45]) {
    const shoulder = shoulderPoint("right");
    const wrist = wristAt(x);
    const elbow = elbowPoint("right", shoulder, wrist);
    const along = vec3.dot(vec3.sub(elbow, shoulder), vec3.normalize(vec3.sub(wrist, shoulder)));
    const onLine = vec3.add(shoulder, vec3.scale(vec3.normalize(vec3.sub(wrist, shoulder)), along));
    assert.ok(elbow[1] < onLine[1], `the elbow hangs down at ${x}`);
    assert.ok(elbow[0] > onLine[0], `the elbow is out from the body at ${x}`);
    // Swinging it out lifts it and carries it further from the body.
    const swung = elbowPoint("right", shoulder, wrist, 40 * DEG);
    assert.ok(swung[1] > elbow[1] && swung[0] > elbow[0], `the elbow swings up and out at ${x}`);
  }
  const mirrored = elbowPoint("left", shoulderPoint("left"), wristAt(-0.3), 0.2);
  const right = elbowPoint("right", shoulderPoint("right"), wristAt(0.3), 0.2);
  assert.ok(near(mirrored[0], -right[0]) && near(mirrored[1], right[1]) && near(mirrored[2], right[2]), "a left arm mirrors a right one");
});

test("the forearm turns as the hand travels along the keyboard", () => {
  const headings = [-0.2, 0, 0.2, 0.4, 0.55].map((x) => heading(forearmDirection("right", wristAt(x))));
  for (let index = 1; index < headings.length; index += 1) {
    assert.ok(headings[index] < headings[index - 1] - 5, "reaching further right swings the forearm further right");
  }
  assert.ok(headings[1] > 25, "in front of the body the forearm comes in from the side");
  assert.ok(headings.at(-1) < -25, "at the top of the keyboard it points outward");
});

test("a hand is turned toward its forearm, and the wrist takes up the rest", () => {
  const solveAt = (notes) => {
    const solved = solvePose(rig, notes.map(([note, finger]) => ({ finger, key: keyFor(noteToMidi(note)), state: "rest" })));
    const pose = describePose(solved.pose);
    const forearm = heading(forearmDirection("right", [pose.x, pose.y, pose.z], pose.elbow * DEG));
    return { solved, pose, forearm, bend: pose.yaw - forearm };
  };
  const bass = solveAt([["C3", 1], ["D3", 2], ["E3", 3], ["F3", 4], ["G3", 5]]);
  const middle = solveAt([["C4", 1], ["D4", 2], ["E4", 3], ["F4", 4], ["G4", 5]]);
  const treble = solveAt([["C7", 1], ["D7", 2], ["E7", 3], ["F7", 4], ["G7", 5]]);
  assert.ok(bass.pose.yaw > middle.pose.yaw + 1 && middle.pose.yaw > treble.pose.yaw + 8, "the hand turns with the arm as it moves up the keyboard");
  assert.ok(middle.pose.yaw > 4 && treble.pose.yaw < -4, "it points inward in front of the body and outward at the top");
  for (const [name, position] of Object.entries({ bass, middle, treble })) {
    assert.ok(position.solved.error < 0.001, `${name}: fingertips stay on their keys`);
    assert.ok(Math.sign(position.pose.yaw) === Math.sign(position.forearm) && Math.abs(position.pose.yaw) < Math.abs(position.forearm), `${name}: the hand turns part of the way to the forearm`);
    assert.ok(position.bend > -32 && position.bend < 24, `${name}: the wrist bends ${position.bend.toFixed(0)} degrees, no more than a wrist can`);
    assert.ok(position.pose.elbow >= ELBOW_SWING[0] / DEG - 1e-6 && position.pose.elbow <= ELBOW_SWING[1] / DEG + 1e-6, `${name}: the elbow stays where an elbow can go`);
  }
});

test("a resting hand lies on the thigh, within reach, and below the keyboard", () => {
  const pose = lapPose();
  const wrist = [pose[0], pose[1], pose[2]];
  assert.deepEqual(wrist, BODY.lap.wrist);
  assert.ok(wrist[1] < -0.05 && wrist[1] > BODY.bench.top, "between the keyboard and the bench");
  assert.deepEqual(leanFor({ right: wrist, left: [-wrist[0], wrist[1], wrist[2]] }), { side: 0, forward: 0 });
});
