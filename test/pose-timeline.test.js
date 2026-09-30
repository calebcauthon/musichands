import assert from "node:assert/strict";
import test from "node:test";
import { advanceSegments } from "../pose-timeline.js";
import { blendPose } from "../hand-rig.js";

const pose = (x) => ({ pose: [x, 0, 0], scale: 1 });
const segment = (from, to, duration) => ({ from: pose(from), to: pose(to), duration, ease: (t) => t, arc: 0 });

test("a delayed frame consumes elapsed time across approach and press", () => {
  const segments = [{ ...segment(0, 1, 10), start: 100 }, segment(1, 2, 10)];
  const drawn = [];
  assert.equal(advanceSegments(segments, 115, (state) => drawn.push(state.pose[0]), blendPose), true);
  assert.deepEqual(drawn, [1.5]);
  assert.equal(advanceSegments(segments, 133, (state) => drawn.push(state.pose[0]), blendPose), false);
  assert.equal(drawn.at(-1), 2);
  assert.equal(segments.length, 0);
});

test("fast moves completed between frames reach their final pose in one update", () => {
  const segments = [{ ...segment(0, 1, 8), start: 0 }, segment(1, 2, 8), segment(2, 3, 8)];
  const drawn = [];
  advanceSegments(segments, 34, (state) => drawn.push(state.pose[0]), blendPose);
  assert.deepEqual(drawn, [3], "one pose computation, no obsolete intermediate poses");
});

test("an exit callback fires once even after a long stall", () => {
  let calls = 0;
  const segments = [{ ...segment(0, 1, 10), start: 0, done: () => calls++ }];
  advanceSegments(segments, 1000, () => {}, blendPose);
  advanceSegments(segments, 2000, () => {}, blendPose);
  assert.equal(calls, 1);
});
