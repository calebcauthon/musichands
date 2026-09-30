import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { countCorrections, matchingMoments, withCorrection } from "../corrections.js";
import { assignFingering } from "../fingering.js";
import { cleanOverrides, createAppServer } from "../server.js";

const event = (measure, beat, hand, midis) => ({ measure: String(measure), beat, hand, time: (measure - 1) * 4 + beat - 1, notes: midis.map((midi) => ({ midi, note: `n${midi}` })) });

test("a correction can reach every moment where the hand plays the same notes", () => {
  const events = [event(1, 1, "right", [60, 64, 67]), event(1, 3, "left", [60, 64, 67]), event(2, 1, "right", [60, 64, 67]), event(2, 2, "right", [60, 64]), event(3, 1, "right", [60, 64, 67])];
  const same = matchingMoments(events, events[0]);
  assert.deepEqual(same.map((moment) => `${moment.measure}:${moment.beat}`), ["1:1", "2:1", "3:1"], "same hand, exactly the same notes");
});

test("corrections are kept by moment, hand and note, and can be taken back", () => {
  const moments = [event(1, 1, "right", [60]), event(3, 1.5, "right", [60])];
  let overrides = withCorrection({}, moments, "right", "C4", 2);
  assert.deepEqual(overrides, { "1:1": { right: { C4: 2 } }, "3:1.5": { right: { C4: 2 } } });
  overrides = withCorrection(overrides, [moments[0]], "right", "E4", 4);
  assert.deepEqual(overrides["1:1"], { right: { C4: 2, E4: 4 } });
  assert.equal(countCorrections(overrides), 3);
  overrides = withCorrection(overrides, moments, "right", "C4", null);
  assert.deepEqual(overrides, { "1:1": { right: { E4: 4 } } }, "an empty moment disappears");
  assert.equal(countCorrections({ _format: "notes", "1:1": { left: { A1: 5 } } }), 1, "a sidecar's own note about its format is not a correction");
});

test("a correction beats a fingering written in the score", () => {
  const events = [{ ...event(1, 1, "right", [60, 64]), notes: [{ midi: 60, note: "C4", finger: 1 }, { midi: 64, note: "E4", finger: 3 }] }];
  const plain = assignFingering(events).events[0];
  assert.deepEqual(plain.notes.map((note) => note.finger), [1, 3]);
  const corrected = assignFingering(events, { overrides: { "1:1": { right: { E4: 2 } } } }).events[0];
  assert.deepEqual(corrected.notes.map((note) => note.finger), [1, 2]);
  assert.equal(corrected.fingeringSource, "override");
});

test("the server keeps corrections by score, and only cleanly shaped ones", async () => {
  assert.deepEqual(cleanOverrides({ "1:1": { right: { C4: 2, E4: "9", "bad note": 3 }, up: { C4: 1 } }, "x": 5, _format: "text" }), { "1:1": { right: { C4: 2 } } });
  assert.equal(cleanOverrides([1, 2]), null);
  assert.equal(cleanOverrides("no"), null);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "musichands-"));
  const server = createAppServer(undefined, { dataDir, editKey: "" });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const id = "a".repeat(64);
  try {
    assert.equal((await fetch(`${base}/api/fingerings/${id}`)).status, 404, "nothing saved yet");
    const put = await fetch(`${base}/api/fingerings/${id}`, { method: "PUT", body: JSON.stringify({ "2:3": { left: { A2: 5 } } }) });
    assert.equal(put.status, 200);
    const back = await (await fetch(`${base}/api/fingerings/${id}`)).json();
    assert.deepEqual(back, { "2:3": { left: { A2: 5 } } });
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "fingerings", `${id}.json`), "utf8")), back);
    assert.equal((await fetch(`${base}/api/fingerings/not-a-score`)).status, 404);
    assert.equal((await fetch(`${base}/api/fingerings/${id}`, { method: "PUT", body: "{" })).status, 400);
    assert.equal((await fetch(`${base}/api/fingerings/${id}`, { method: "DELETE" })).status, 405);
    assert.equal((await fetch(`${base}/api/anything`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("with an editing key set, saving needs it and reading does not", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "musichands-"));
  const server = createAppServer(undefined, { dataDir, editKey: "open-sesame" });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const id = "b".repeat(64);
  const body = JSON.stringify({ "1:1": { right: { C4: 1 } } });
  try {
    assert.equal((await fetch(`${base}/api/fingerings/${id}`, { method: "PUT", body })).status, 401);
    assert.equal((await fetch(`${base}/api/fingerings/${id}`, { method: "PUT", body, headers: { "x-edit-key": "wrong" } })).status, 401);
    assert.equal((await fetch(`${base}/api/fingerings/${id}`, { method: "PUT", body, headers: { "x-edit-key": "open-sesame" } })).status, 200);
    assert.equal((await fetch(`${base}/api/fingerings/${id}`)).status, 200, "anyone may read");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
