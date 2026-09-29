import assert from "node:assert/strict";
import test from "node:test";
import { dueForCut, MAX_SHOTS, readShots, SHOT_LENGTH, ShotList, STARTER_SHOTS } from "../camera-shots.js";

const view = (azimuth, elevation = 40, zoom = 1) => ({ azimuth, elevation, zoom });

test("there are views to cut between before any are saved", () => {
  const shots = new ShotList();
  assert.ok(shots.length >= 3);
  assert.deepEqual(shots.views[0], STARTER_SHOTS[0]);
  shots.views[0].azimuth = 99;
  assert.notEqual(STARTER_SHOTS[0].azimuth, 99, "the starter views are not changed by use");
});

test("saving a view adds it once", () => {
  const shots = new ShotList([]);
  assert.equal(shots.add(view(10)), 0);
  assert.equal(shots.add(view(50)), 1);
  assert.equal(shots.add(view(10.2)), 0, "a view already saved is not saved again");
  assert.equal(shots.length, 2);
  for (let n = 0; n < 20; n += 1) shots.add(view(-100 + n * 5, 20 + n));
  assert.equal(shots.length, MAX_SHOTS);
  assert.equal(shots.add(view(149, 80)), -1, "the list does not grow without end");
});

test("cuts go round the saved views in order", () => {
  const shots = new ShotList([view(0), view(30), view(60)]);
  assert.deepEqual([shots.next(), shots.next(), shots.next(), shots.next()].map((shot) => shot.azimuth), [0, 30, 60, 0]);
});

test("a cut never lands on the view the camera already has", () => {
  const shots = new ShotList([view(0), view(30), view(60)]);
  assert.equal(shots.next(view(0)).azimuth, 30);
  assert.equal(shots.next(view(60)).azimuth, 0);
  assert.equal(new ShotList([view(5)]).next(view(5)).azimuth, 5, "with one view there is nowhere else to go");
  assert.equal(new ShotList([]).next(), null);
});

test("removing a view keeps the order of the rest", () => {
  const shots = new ShotList([view(0), view(30), view(60)]);
  shots.next();
  shots.next(); // on the second
  shots.remove(0);
  assert.deepEqual(shots.views.map((shot) => shot.azimuth), [30, 60]);
  assert.equal(shots.next().azimuth, 60, "the next cut still goes to the view after the current one");
  shots.remove(7);
  assert.equal(shots.length, 2);
});

test("cuts wait for the start of a measure and for the shot to have had its time", () => {
  const base = { lastCut: 1000, shots: 3, measureStarted: true };
  assert.equal(dueForCut({ ...base, now: 1000 + SHOT_LENGTH }), true);
  assert.equal(dueForCut({ ...base, now: 1000 + SHOT_LENGTH - 1 }), false);
  assert.equal(dueForCut({ ...base, now: 99999, measureStarted: false }), false);
  assert.equal(dueForCut({ ...base, now: 99999, shots: 1 }), false, "one view is not enough to cut between");
});

test("saved views are read back carefully", () => {
  assert.deepEqual(readShots('[{"azimuth":10,"elevation":20,"zoom":1.5},{"azimuth":"x"},{"azimuth":500,"elevation":50}]'), [
    { azimuth: 10, elevation: 20, zoom: 1.5 },
    { azimuth: 150, elevation: 50, zoom: 1 },
  ]);
  assert.equal(readShots("{}"), null);
  assert.equal(readShots("nonsense"), null);
  assert.equal(readShots(null), null);
});
