import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyHandMoves, countCorrections, matchingMoments, withCorrection } from "../corrections.js";
import { assignFingering } from "../fingering.js";
import { createAppServer } from "../server.js";
import { parseConnection, workspaceFromHash } from "../workspace-client.js";
import { cleanState, defaultState, mergeState, projectScreen } from "../workspace-model.js";

const event = (measure, beat, hand, midis) => ({ measure: String(measure), beat, hand, time: (measure - 1) * 4 + beat - 1, duration: 1, attack: true, notes: midis.map((midi) => ({ midi, note: `n${midi}`, duration: 1 })) });

test("a correction can reach every moment where the hand plays the same notes", () => {
  const events = [event(1, 1, "right", [60, 64, 67]), event(1, 3, "left", [60, 64, 67]), event(2, 1, "right", [60, 64, 67]), event(2, 2, "right", [60, 64]), event(3, 1, "right", [60, 64, 67])];
  assert.deepEqual(matchingMoments(events, events[0]).map((moment) => `${moment.measure}:${moment.beat}`), ["1:1", "2:1", "3:1"]);
});

test("corrections are kept by moment, hand and note, and can be taken back", () => {
  const moments = [event(1, 1, "right", [60]), event(3, 1.5, "right", [60])];
  let overrides = withCorrection({}, moments, "right", "C4", 2);
  assert.deepEqual(overrides, { "1:1": { right: { C4: 2 } }, "3:1.5": { right: { C4: 2 } } });
  overrides = withCorrection(overrides, [moments[0]], "right", "E4", 4);
  assert.equal(countCorrections(overrides), 3);
  overrides = withCorrection(overrides, moments, "right", "C4", null);
  assert.deepEqual(overrides, { "1:1": { right: { E4: 4 } } });
});

test("a correction beats a fingering written in the score", () => {
  const events = [{ ...event(1, 1, "right", [60, 64]), notes: [{ midi: 60, note: "C4", finger: 1 }, { midi: 64, note: "E4", finger: 3 }] }];
  assert.deepEqual(assignFingering(events).events[0].notes.map((note) => note.finger), [1, 3]);
  const corrected = assignFingering(events, { overrides: { "1:1": { right: { E4: 2 } } } }).events[0];
  assert.deepEqual(corrected.notes.map((note) => note.finger), [1, 2]);
  assert.equal(corrected.fingeringSource, "override");
});

test("a note can be handed to the other hand", () => {
  const events = [event(1, 1, "right", [60, 64]), event(1, 1, "left", [48]), event(1, 2, "right", [67])];
  const moved = applyHandMoves(events, { "1:1": { n60: "left" }, "1:2": { n67: "left" } });
  const show = (list) => list.map((entry) => `${entry.time}:${entry.hand}:${entry.notes.map((note) => note.midi).join("+")}`);
  assert.deepEqual(show(moved), ["0:right:64", "0:left:48+60", "1:left:67"], "the note joins the other hand's event, or starts one");
  assert.equal(moved[2].attack, true);
  assert.deepEqual(show(applyHandMoves(events, {})), show(events));
});

test("a workspace state is cleaned to what the page can show", () => {
  const state = cleanState({ time: -3, tempo: 999, reflexes: "fast", playing: 1, camera: { view: { azimuth: 400, elevation: 30 }, autoCut: "yes" }, hands: { left: { show: false, sound: "no" } }, corrections: { fingers: { "1:1": { right: { C4: 9, D4: 2 } } }, hands: { "2:1": { E4: "left", F4: "up" } } }, command: { type: "dance" }, extra: 1 });
  assert.equal(state.time, 0);
  assert.equal(state.tempo, 240);
  assert.equal(state.reflexes, 1);
  assert.equal(state.playing, true);
  assert.equal(state.camera.view.azimuth, 150);
  assert.equal(state.camera.autoCut, true);
  assert.deepEqual(state.hands.left, { show: false, sound: true });
  assert.deepEqual(state.corrections, { fingers: { "1:1": { right: { D4: 2 } } }, hands: { "2:1": { E4: "left" } } });
  assert.equal(state.command, null);
  assert.equal("extra" in state, false);
});

test("a change is laid over the state: objects merge, null takes away, numbers replace", () => {
  let state = defaultState();
  state = mergeState(state, { tempo: 90, corrections: { fingers: { "1:1": { right: { C4: 2 } } } } });
  state = mergeState(state, { corrections: { fingers: { "1:1": { right: { E4: 3 } }, "2:1": { left: { G2: 5 } } } } });
  assert.deepEqual(state.corrections.fingers, { "1:1": { right: { C4: 2, E4: 3 } }, "2:1": { left: { G2: 5 } } });
  state = mergeState(state, { corrections: { fingers: { "1:1": { right: { C4: null } } } } });
  assert.deepEqual(state.corrections.fingers["1:1"], { right: { E4: 3 } });
  assert.equal(state.tempo, 90);
  state = mergeState(state, { tempo: null });
  assert.equal(state.tempo, null, "a null tempo means the score's own");
  state = mergeState(state, { camera: { shots: [{ azimuth: 10, elevation: 40, zoom: 1 }] } });
  assert.equal(state.camera.shots.length, 1);
  state = mergeState(state, { camera: { shots: null } });
  assert.equal(state.camera.shots, null, "null shots means the ready-made ones");
});

test("the screen says what each hand is doing at the workspace's moment", () => {
  const events = [event(1, 1, "right", [60, 64]), event(1, 1, "left", [48]), event(1, 3, "right", [67])];
  events[2].notes[0].held = true;
  events[2].attack = false;
  const fingered = assignFingering(events, { overrides: {} });
  const state = { ...defaultState(), time: 2 };
  const screen = projectScreen({ title: "T", measures: [1], tempo: 100 }, fingered.events, fingered.positions, state);
  assert.equal(screen.time, 0, "the moment shown is the last struck moment at or before the workspace time");
  assert.equal(screen.measure, "1");
  assert.deepEqual(screen.hands.right.notes.map((note) => note.note), ["n60", "n64"]);
  assert.equal(screen.hands.right.notes[0].finger, 1);
  assert.equal(screen.step.count, 1);
});

async function withServer(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "musichands-"));
  const server = createAppServer(undefined, { dataDir });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("workspaces are made, read, changed, copied and deleted, each behind its own token", async () => {
  await withServer(async (base) => {
    const made = await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Evening practice" }) })).json();
    assert.match(made.id, /^ws-[a-z0-9]{10}$/);
    assert.ok(made.token.length > 20);
    assert.match(made.connectionString, /Workspace: ws-/);
    assert.match(made.url, /#ws=ws-.*&token=/);
    const auth = { authorization: `Bearer ${made.token}` };
    assert.equal((await fetch(`${base}/api/workspaces/${made.id}`)).status, 401, "no token, no entry");
    assert.equal((await fetch(`${base}/api/workspaces/${made.id}`, { headers: { authorization: "Bearer nope" } })).status, 401);
    const read = await (await fetch(`${base}/api/workspaces/${made.id}`, { headers: auth })).json();
    assert.equal(read.name, "Evening practice");
    assert.equal(read.state.time, 0);

    const changed = await (await fetch(`${base}/api/workspaces/${made.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ time: 8, corrections: { fingers: { "3:1": { left: { G2: 5 } } } } }) })).json();
    assert.equal(changed.version, 2);
    assert.equal(changed.state.time, 8);
    assert.deepEqual(changed.state.corrections.fingers, { "3:1": { left: { G2: 5 } } });

    const copy = await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Try another fingering", copyFrom: { id: made.id, token: made.token } }) })).json();
    assert.notEqual(copy.id, made.id);
    assert.equal(copy.state.time, 8, "a copy starts from the original's state");
    assert.equal((await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ copyFrom: { id: made.id, token: "wrong" } }) })).status, 403);

    const screen = await (await fetch(`${base}/api/workspaces/${made.id}/screen`, { headers: auth })).json();
    assert.equal(screen.score.title, "Minor Descent");
    assert.equal(screen.time, 8);
    assert.ok(screen.hands.left.notes.length >= 1);
    assert.equal(screen.hands.left.notes.find((note) => note.note === "G2")?.finger, 5, "the correction shows in the projection");

    const command = await (await fetch(`${base}/api/workspaces/${made.id}/commands`, { method: "POST", headers: auth, body: JSON.stringify({ type: "play" }) })).json();
    assert.deepEqual(command.command, { seq: 1, type: "play", by: "" });
    assert.equal((await fetch(`${base}/api/workspaces/${made.id}/commands`, { method: "POST", headers: auth, body: JSON.stringify({ type: "dance" }) })).status, 400);

    assert.equal((await fetch(`${base}/api/workspaces/${made.id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/workspaces/${made.id}`, { headers: auth })).status, 404);
  });
});

test("a score can be uploaded and put in a workspace", async () => {
  await withServer(async (base) => {
    const xml = `<score-partwise><work><work-title>Two Notes</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><staves>2</staves></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff></note><backup><duration>4</duration></backup><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><staff>2</staff></note></measure></part></score-partwise>`;
    const uploaded = await (await fetch(`${base}/api/scores`, { method: "POST", headers: { "content-type": "application/vnd.recordare.musicxml+xml" }, body: xml })).json();
    assert.match(uploaded.id, /^[0-9a-f]{64}$/);
    assert.equal(uploaded.title, "Two Notes");
    assert.equal((await fetch(`${base}/api/scores`, { method: "POST", body: "not music" })).status, 400);
    const made = await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ state: { score: { kind: "uploaded", id: uploaded.id, title: uploaded.title } } }) })).json();
    const auth = { authorization: `Bearer ${made.token}` };
    const screen = await (await fetch(`${base}/api/workspaces/${made.id}/screen`, { headers: auth })).json();
    assert.equal(screen.score.title, "Two Notes");
    assert.deepEqual(screen.hands.right.notes.map((note) => note.note), ["C4"]);
    const moved = await (await fetch(`${base}/api/workspaces/${made.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ corrections: { hands: { "1:1": { C4: "left" } } } }) })).json();
    assert.deepEqual(moved.state.corrections.hands, { "1:1": { C4: "left" } });
    const after = await (await fetch(`${base}/api/workspaces/${made.id}/screen`, { headers: auth })).json();
    assert.deepEqual(after.hands.right.notes, []);
    assert.deepEqual(after.hands.left.notes.map((note) => note.note), ["C3", "C4"]);
    const text = await (await fetch(`${base}/api/workspaces/${made.id}/score`, { headers: auth })).text();
    assert.match(text, /Two Notes/);
  });
});

test("changes reach every browser watching the workspace", async () => {
  await withServer(async (base) => {
    const made = await (await fetch(`${base}/api/workspaces`, { method: "POST", body: "{}" })).json();
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/workspaces/${made.id}/events?token=${made.token}&client=browser-a`, { signal: controller.signal });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (pattern) => {
      for (let tries = 0; tries < 50 && !pattern.test(text); tries += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      assert.match(text, pattern);
    };
    await until(/event: lead\ndata: \{"lead":true\}/);
    await fetch(`${base}/api/workspaces/${made.id}`, { method: "PATCH", headers: { authorization: `Bearer ${made.token}`, "x-client": "agent" }, body: JSON.stringify({ time: 12 }) });
    await until(/"time":12[\s\S]*"by":"agent"/);
    controller.abort();
  });
});

test("a workspace is found in a page address, a link or a connection string", () => {
  const token = "5QmZ0Yv7c8Wq9Ls2Xd4Rt6Bn1Kp3Hj0V";
  assert.deepEqual(workspaceFromHash(`#ws=ws-k3j9x2m1qa&token=${token}`), { id: "ws-k3j9x2m1qa", token });
  assert.equal(workspaceFromHash("#ws=ws-k3j9x2m1qa"), null, "a token is needed");
  assert.deepEqual(parseConnection(`https://example.test/#ws=ws-k3j9x2m1qa&token=${token}`), { id: "ws-k3j9x2m1qa", token });
  assert.deepEqual(parseConnection(`MusicHands workspace "Evening"\nURL: https://example.test\nWorkspace: ws-k3j9x2m1qa\nToken: ${token}\nManual: https://example.test/agent.md`), { id: "ws-k3j9x2m1qa", token });
  assert.equal(parseConnection("nothing here"), null);
});

test("the manual is served, and PUT replaces the whole state", async () => {
  await withServer(async (base) => {
    const manual = await fetch(`${base}/agent.md`);
    assert.equal(manual.status, 200);
    assert.match(await manual.text(), /GET \/api\/workspaces\/<id>\/screen/);
    const made = await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ state: { time: 6, numbers: false } }) })).json();
    const auth = { authorization: `Bearer ${made.token}` };
    const put = await (await fetch(`${base}/api/workspaces/${made.id}`, { method: "PUT", headers: auth, body: JSON.stringify({ tempo: 90 }) })).json();
    assert.equal(put.state.tempo, 90);
    assert.equal(put.state.time, 0, "what PUT leaves out goes back to its default");
    assert.equal(put.state.numbers, true);
  });
});
