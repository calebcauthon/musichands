import assert from "node:assert/strict";
import test from "node:test";
import { HandPlayer, planNotes } from "../hand-player.js";
import { nearestSample, SAMPLES } from "../piano-audio.js";

test("playing together puts every note down at once", () => {
  const plan = planNotes([67, 60, 64], "together");
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].midis, [60, 64, 67]);
  assert.equal(plan[0].at, 0);
});

test("playing one by one goes up from the lowest note, one at a time", () => {
  const plan = planNotes([67, 60, 64, 60], "succession");
  assert.deepEqual(plan.map((step) => step.midis), [[60], [64], [67]]);
  assert.ok(plan[1].at > plan[0].at && plan[2].at - plan[1].at === plan[1].at - plan[0].at, "notes are evenly spaced");
  assert.deepEqual(planNotes([], "succession"), []);
});

test("the player presses fingers and sounds each note when its key lands", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const log = [];
  const audio = { noteOn: (midi, options) => log.push(["sound", midi, options.delay]), releaseAll: () => log.push(["damp"]) };
  const player = new HandPlayer({
    audio,
    press: (midis) => {
      log.push(["press", ...midis]);
      return 300;
    },
    release: () => log.push(["lift"]),
  });
  player.play([64, 60], "succession");
  assert.equal(player.mode, "succession");
  context.mock.timers.tick(0);
  assert.deepEqual(log, [["press", 60], ["sound", 60, 300]]);
  context.mock.timers.tick(600);
  assert.deepEqual(log.slice(2), [["press", 64], ["sound", 64, 300]]);
  context.mock.timers.tick(5000);
  assert.deepEqual(log.at(-1), ["lift"]);
  assert.equal(player.mode, null);
});

test("stopping the player cancels what has not happened yet", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pressed = [];
  let damped = 0;
  const player = new HandPlayer({
    audio: { noteOn: () => {}, releaseAll: () => (damped += 1) },
    press: (midis) => pressed.push(...midis),
    release: () => {},
  });
  player.play([60, 62, 64], "succession");
  context.mock.timers.tick(0);
  player.stop();
  context.mock.timers.tick(5000);
  assert.deepEqual(pressed, [60]);
  assert.equal(damped, 1);
});

test("every note has a recording within a semitone and a half", () => {
  assert.equal(SAMPLES.length, 30);
  for (let midi = 21; midi <= 108; midi += 1) {
    const sample = nearestSample(midi);
    assert.ok(Math.abs(sample.midi - midi) <= 1, `note ${midi} is too far from ${sample.name}`);
    assert.ok(Math.abs(sample.rate - 2 ** ((midi - sample.midi) / 12)) < 1e-12);
  }
  assert.deepEqual([nearestSample(69).name, nearestSample(69).rate], ["A4", 1]);
  assert.equal(nearestSample(60).name, "C4");
});
