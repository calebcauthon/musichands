import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DRILL, drillPose, drillProgress, drillStages, drillSteps, roundTempo } from "../drill.js";
import { assignFingering } from "../fingering.js";
import { cleanLesson } from "../lesson.js";
import { parseScore } from "../score-model.js";

async function minorDescent() {
  const score = parseScore(await readFile(new URL("../scores/minor-descent.musicxml", import.meta.url), "utf8"));
  const fingered = assignFingering(score.events);
  return { score, positions: fingered.positions, events: fingered.events, tempo: 80 };
}

test("the drill takes each hand that plays, then both, and lists every step", async () => {
  const music = await minorDescent();
  const lesson = { from: 0, to: 1 };
  assert.deepEqual(drillStages(lesson, music), ["right", "left", "both"]);
  const steps = drillSteps(lesson, music);
  const perStage = 1 + DRILL.rounds.reduce((sum, round) => sum + round.times, 0);
  assert.equal(steps.length, 3 * perStage);
  assert.deepEqual(steps[0], { stage: "right", kind: "show", label: "Right hand · the position", tempo: 40, hold: DRILL.hold });
  assert.deepEqual(steps[1], { stage: "right", kind: "play", label: "Right hand · slowly, 40", tempo: 40, round: 0, time: 1, times: 4, gap: DRILL.gap });
  assert.equal(steps[4].time, 4, "four times slowly");
  assert.deepEqual([steps[5].label, steps[5].tempo, steps[5].times], ["Right hand · a little faster, 60", 60, 2]);
  assert.deepEqual([steps[7].label, steps[7].tempo], ["Right hand · at full tempo, 80", 80]);
  assert.equal(steps[perStage].stage, "left");
  assert.equal(steps[2 * perStage].stage, "both");
  assert.equal(drillProgress(steps[perStage], steps), `${perStage + 1} of ${steps.length}`);
  assert.equal(drillProgress({}, steps), "");
});

test("a hand that does not play has no stage; the rounds never go below the slowest tempo", async () => {
  const music = await minorDescent();
  const rightOnly = { ...music, events: music.events.filter((event) => event.hand === "right") };
  assert.deepEqual(drillStages({ from: 0, to: 1 }, rightOnly), ["right"]);
  assert.deepEqual(drillStages({ from: 0, to: 1 }, { ...music, events: [] }), []);
  assert.equal(roundTempo({ share: 0.5 }, 40), 30);
  assert.equal(roundTempo({ share: 1 }, 40), 40);
  const custom = drillSteps({ from: 0, to: 0 }, rightOnly, { hold: 1, gap: 2, rounds: [{ share: 1, times: 1, name: "once" }] });
  assert.deepEqual(custom.map((step) => step.kind), ["show", "play"]);
});

test("the position shown is every finger of each hand's first position, nothing pressed", async () => {
  const music = await minorDescent();
  const lesson = { from: 0, to: 1 };
  const right = drillPose("right", lesson, music);
  assert.equal(right.left, null);
  assert.ok(right.right.fingers.length >= 2);
  assert.deepEqual(right.right.press, []);
  const both = drillPose("both", lesson, music);
  assert.ok(both.left.fingers.length && both.right.fingers.length);
  assert.deepEqual(both.right, right.right);
});

test("a drill's lesson keeps its step and mode", () => {
  assert.deepEqual(cleanLesson({ mode: "drill", from: 2, to: 3, step: 5, score: "abc", extra: { no: true } }), { step: 5, mode: "drill", from: 2, to: 3, score: "abc" });
  assert.deepEqual(cleanLesson({ from: 2, to: 3 }), { mode: "teacher", from: 2, to: 3, style: "lead" }, "a lesson with no mode is the teacher's");
});
