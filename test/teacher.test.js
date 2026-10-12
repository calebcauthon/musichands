// The agent over HTTP, with a model that answers what the test tells it to:
// a word brings it, its acts reach the screen and their results reach the
// model, the learner's words cut acts short, fingerings and the screen
// change, a lesson is laid over it and taken away again, a conversation gone
// cold is dropped, and its notes last.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheMarked, createAppServer } from "../server.js";
import { LESSON_TOOLS, TEACH_TOOL, TOOLS } from "../teacher.js";

const COMPANY_TOOLS = [...TOOLS, TEACH_TOOL];
const TEACHING_TOOLS = [...TOOLS, ...LESSON_TOOLS];

// A model whose every answer the test hands it, and which keeps what it was asked.
function scriptedModel() {
  const waiting = []; // calls waiting for an answer
  const answers = []; // answers waiting for a call
  const model = async (messages, tools) => {
    model.calls.push({ messages: structuredClone(messages), tools });
    if (answers.length) return answers.shift();
    return new Promise((resolve) => waiting.push(resolve));
  };
  model.calls = [];
  model.answer = (reply) => (waiting.length ? waiting.shift()(reply) : answers.push(reply));
  model.label = "test";
  return model;
}
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const last = (model, back = 1) => JSON.parse(model.calls.at(-1).messages.at(-back).content);
// Waits for the model to have been asked `n` times.
async function untilCalls(model, n) {
  for (let tries = 0; tries < 200 && model.calls.length < n; tries += 1) await sleep(10);
  assert.equal(model.calls.length, n);
}

// Reads a server-sent-events stream into a queue the test can wait on.
async function openEvents(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  const waiting = [];
  const push = (event) => (waiting.length ? waiting.shift()(event) : events.push(event));
  (async () => {
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const name = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (name && data) push({ event: name, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  const next = () => (events.length ? Promise.resolve(events.shift()) : new Promise((resolve) => waiting.push(resolve)));
  // The next event of that kind, letting the others go by.
  const nextOf = async (kind) => {
    for (;;) {
      const event = await next();
      if (event.event === kind) return event.data;
    }
  };
  return { next, nextOf, close: () => controller.abort() };
}

async function withTeacher(model, body, { hear = null, stale = undefined } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "musichands-"));
  const server = createAppServer(undefined, { dataDir, model, speak: null, hear, stale });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    const made = await (await fetch(`${base}/api/workspaces`, { method: "POST", body: "{}" })).json();
    const headers = { authorization: `Bearer ${made.token}`, "content-type": "application/json", "x-client": "test" };
    const at = `${base}/api/workspaces/${made.id}`;
    const api = (part, method = "GET", payload = undefined) => fetch(`${at}${part}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const state = async () => (await (await api("")).json()).state;
    await body({ base, made, api, state, at, headers });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a lesson: the teacher's acts reach the screen, their results reach the model, the learner cuts in, the lesson ends and the agent stays", async () => {
  const model = scriptedModel();
  await withTeacher(model, async ({ api, state, at, made }) => {
    assert.deepEqual(await (await api("/teacher")).json(), { on: false });

    const started = await api("/teacher", "POST", { from: 0, to: 1, style: "hands-separate", said: "You lead the way." });
    assert.equal(started.status, 201);
    const status = await started.json();
    assert.deepEqual(status.lesson, { mode: "teacher", from: 0, to: 1, style: "hands-separate", score: made.state.score.id });
    assert.deepEqual(status.transcript, [{ n: 0, who: "learner", text: "You lead the way." }]);
    assert.equal((await api("/teacher", "POST", { from: 0, to: 1 })).status, 409, "one lesson at a time");
    const set = await state();
    assert.deepEqual(set.lesson, status.lesson, "the teacher puts the lesson in the workspace");
    assert.deepEqual(set.passage, { from: 0, to: 1, times: 1 });
    assert.equal(set.camera.view.elevation, 87, "seen from straight above");

    const events = await openEvents(`${at}/teacher/events?token=${made.token}&client=test`);
    try {
      // What the model was asked: the agent's prompt with the lesson laid over it, and the opening message with the screen.
      await sleep(20);
      assert.equal(model.calls.length, 1);
      const [system, opening] = model.calls[0].messages;
      assert.equal(system.role, "system");
      assert.match(system.content, /^You are beside one adult at a piano/);
      assert.match(system.content, /THE LESSON\nA lesson is on/);
      assert.match(system.content, /Right hand alone/, "the way of teaching");
      assert.match(system.content, /THE PASSAGE OF THE LESSON\nMeasures 1 to 2 of "Minor Descent"\.\n\nRIGHT HAND\nSits at the start with/, "the brief");
      assert.match(system.content, /The score's tempo is \d+ beats a minute/);
      assert.equal(opening.role, "user");
      assert.match(opening.content, /^The learner has chosen measures 1 to 2 and the way of teaching "Hands separate, then together, then faster"\. They said: "You lead the way\." Begin\.\n\(Screen: measure 1, beat 1; /);
      assert.deepEqual(model.calls[0].tools, TEACHING_TOOLS);

      // Two acts in one turn: performed in order, each answered when the screen says it is done.
      model.answer({ content: "", tool_calls: [call("c1", "say", { text: "[warmly] Hello." }), call("c2", "place", { hand: "right", fingers: [{ finger: 1, note: "C4" }], press: ["C4"] })] });
      assert.deepEqual(await events.nextOf("said"), { n: 1, who: "teacher", text: "[warmly] Hello." });
      const say = await events.nextOf("act");
      assert.deepEqual(say, { id: "1", type: "say", text: "[warmly] Hello." });
      assert.equal(model.calls.length, 1, "the teacher waits for the screen");
      assert.deepEqual(await (await api("/teacher/done", "POST", { id: "1", result: { spoken: true } })).json(), { done: true });
      const place = await events.nextOf("act");
      assert.deepEqual(place, { id: "2", type: "place", hand: "right", fingers: [{ finger: 1, note: "C4" }], press: ["C4"], pauseMs: 1400 });
      await api("/teacher/done", "POST", { id: "2", result: { placed: true } });
      await events.nextOf("status"); // thinking again
      assert.equal(model.calls.length, 2);
      const results = model.calls[1].messages.slice(-2);
      assert.deepEqual(results.map((message) => [message.role, message.tool_call_id, JSON.parse(message.content)]), [["tool", "c1", { spoken: true }], ["tool", "c2", { placed: true }]]);

      // Plain words are spoken and then it is the learner's turn.
      model.answer({ content: "Now you try. Press Got it when you have it." });
      const spoken = await events.nextOf("act");
      assert.equal(spoken.text, "Now you try. Press Got it when you have it.");
      await api("/teacher/done", "POST", { id: spoken.id, result: { spoken: true } });
      assert.equal((await events.nextOf("status")).status, "listening");
      assert.equal(model.calls.length, 2, "nothing is asked until the learner answers");
      assert.deepEqual(await (await api("/teacher/say", "POST", { text: "Got it." })).json(), { heard: true });
      assert.deepEqual(await events.nextOf("said"), { n: 3, who: "learner", text: "Got it." });
      await events.nextOf("status");
      assert.equal(model.calls.length, 3);
      assert.match(model.calls[2].messages.at(-1).content, /^Got it\.\n\(Screen: /, "their words, with where they are");

      // A loop plays until the learner speaks; what they say comes back as the tool's answer, with the screen.
      model.answer({ content: "", tool_calls: [call("c3", "play", { from_measure: "1", to_measure: "2", until_moment: "", hands: "right", tempo: 40, times: 1, loop: true }), call("c4", "say", { text: "Keep going." })] });
      const play = await events.nextOf("act");
      assert.deepEqual(play, { id: "4", type: "play", from: 0, to: 1, start: null, end: null, hands: "right", tempo: 40, times: null, loop: true });
      await api("/teacher/say", "POST", { text: "Too fast, slow down." });
      assert.deepEqual(await events.nextOf("cut"), { id: "4" });
      await events.nextOf("status");
      assert.equal(model.calls.length, 4);
      const [played, skipped] = model.calls[3].messages.slice(-2).map((message) => JSON.parse(message.content));
      assert.equal(played.interrupted, true);
      assert.equal(played.learner_said, "Too fast, slow down.");
      assert.match(played.screen, /^Screen: /);
      assert.deepEqual(skipped, { skipped: true, reason: "the learner spoke first" });

      // Playing up to a moment stops where the next moment would begin; words with the calls are spoken first.
      model.answer({ content: "Listen to the first two.", tool_calls: [call("c5", "play", { from_measure: "1", to_measure: "2", from_moment: "", until_moment: "1:1", hands: "left", tempo: 30, times: 2, loop: false })] });
      const words = await events.nextOf("act");
      assert.deepEqual([words.type, words.text], ["say", "Listen to the first two."]);
      await api("/teacher/done", "POST", { id: words.id, result: { spoken: true } });
      const upTo = await events.nextOf("act");
      assert.deepEqual([upTo.hands, upTo.tempo, upTo.times, upTo.loop, upTo.start], ["left", 30, 2, false, null]);
      assert.equal(upTo.end, 2, "the left hand's next moment is at beat 3 of measure 1");
      await api("/teacher/done", "POST", { id: upTo.id, result: { played: true } });
      await events.nextOf("status");
      // Up to the last moment a hand plays is not the whole passage: it ends when that moment is over.
      model.answer({ content: "", tool_calls: [call("c5b", "play", { from_measure: "1", to_measure: "2", from_moment: "2:1", until_moment: "2:1", hands: "right", tempo: 30, times: 1, loop: false })] });
      const lastOne = await events.nextOf("act");
      assert.equal(lastOne.start, 4, "from the right hand's moment at measure 2");
      assert.equal(lastOne.end, null, "its note lasts to the end of the measures, so the end is the passage's");
      await api("/teacher/done", "POST", { id: lastOne.id, result: { played: true } });
      await events.nextOf("status");
      model.answer({ content: "", tool_calls: [call("c5c", "play", { from_measure: "1", to_measure: "1", from_moment: "", until_moment: "1:1", hands: "right", tempo: 30, times: 1, loop: false })] });
      const one = await events.nextOf("act");
      assert.deepEqual([one.from, one.to, one.start, one.end], [0, 0, null, null], "a whole note alone in its measure: the measure");
      await api("/teacher/done", "POST", { id: one.id, result: { played: true } });
      await events.nextOf("status");

      // A fingering changed: on the screen, and told back as it now stands.
      model.answer({ content: "", tool_calls: [call("c6", "change_fingering", { moment: "1:1", hand: "right", note: "A4", finger: 3, everywhere: false }), call("c7", "look", { from_measure: "1", to_measure: "1" })] });
      await events.nextOf("status");
      assert.equal(model.calls.length, 8);
      const [changed, looked] = model.calls[7].messages.slice(-2).map((message) => JSON.parse(message.content));
      assert.deepEqual(changed.right, "middle on A4");
      assert.equal(changed.changed, 1);
      assert.deepEqual((await state()).corrections.fingers, { "1:1": { right: { A4: 3 } } });
      assert.match(looked.brief, /Measure 1 of "Minor Descent"/);
      assert.match(looked.brief, /1:1 +middle on A4/, "the brief shows the change");
      assert.match(looked.brief, /corrected by the learner/);

      // A wrong moment is an error the model can read; so is a tool it does not have now.
      model.answer({ content: "", tool_calls: [call("c8", "play_moment", { moment: "9:9", hands: "both" }), call("c8b", "teach", { from_measure: "1", to_measure: "1", style: "lead", said: "" })] });
      await events.nextOf("status");
      assert.match(JSON.parse(model.calls[8].messages.at(-2).content).error, /No moment 9:9/);
      assert.match(last(model).error, /No such tool now: teach/);

      // Freehand: the passage reaches the screen as whole-hand poses in ms at the tempo, with the hands to show; a hand it cannot do is an error.
      const notes = [{ keys: [{ finger: 1, note: "A4" }], beats: 1 }, { keys: [{ finger: 2, note: "B4" }], beats: 0.5 }];
      model.answer({ content: "", tool_calls: [call("c8c", "play_notes", { tempo: 120, hands: "right", right: { notes } }), call("c8d", "play_notes", { tempo: 60, hands: "right", right: { notes: [{ keys: [{ finger: 6, note: "A4" }], beats: 1 }] } })] });
      const freehand = await events.nextOf("act");
      const whole = [{ finger: 1, note: "A4" }, { finger: 2, note: "B4" }];
      assert.deepEqual(freehand, {
        id: freehand.id,
        type: "play_notes",
        tempo: 120,
        hands: "right",
        steps: [{ ms: 0, right: { fingers: whole, press: ["A4"], hold: 500 } }, { ms: 500, right: { fingers: whole, press: ["B4"], hold: 250 } }, { ms: 750, right: { fingers: whole, press: [] } }],
      });
      await api("/teacher/done", "POST", { id: freehand.id, result: { played: true } });
      await events.nextOf("status");
      assert.deepEqual(last(model, 2), { played: true });
      assert.match(last(model).error, /right hand, note 1: finger 6 on A4/);

      // Done: the last word is spoken, the piece is put back, and the agent is simply there again.
      model.answer({ content: "", tool_calls: [call("c9", "done", { closing: "That's it for today." })] });
      const closing = await events.nextOf("act");
      assert.equal(closing.text, "That's it for today.");
      await api("/teacher/done", "POST", { id: closing.id, result: { spoken: true } });
      assert.deepEqual(await events.nextOf("lesson"), { on: false, reason: "done" });
      const after = await state();
      assert.equal(after.lesson, null);
      assert.equal(after.passage, null);
      assert.deepEqual(after.hands, { left: { show: true, sound: true }, right: { show: true, sound: true } });
      await events.nextOf("status");
      assert.equal(model.calls.length, 11, "the model is told the lesson is over");
      assert.match(last(model).now, /the lesson is over/);
      assert.deepEqual(model.calls[10].tools, COMPANY_TOOLS, "the lesson's tools are gone");
      assert.doesNotMatch(model.calls[10].messages[0].content, /THE LESSON/, "and so are its instructions");
      assert.equal(model.calls[10].messages.length, model.calls[9].messages.length + 2, "the conversation runs on");
      model.answer({ content: "", tool_calls: [call("c10", "listen", {})] });
      assert.equal((await events.nextOf("status")).status, "listening");
      const still = await (await api("/teacher")).json();
      assert.equal(still.on, true);
      assert.equal(still.lesson, null);
      assert.equal(still.transcript.length, 7, "the whole transcript is kept");
    } finally {
      events.close();
    }
  });
});

test("a lesson ends when it is stopped or when the workspace drops it; the agent goes when sent away or when the piece changes", async () => {
  const model = scriptedModel();
  await withTeacher(model, async ({ api, state, made }) => {
    // Stopped from outside: the lesson ends, the agent stays; a second stop sends the agent away.
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0, style: "lead" })).status, 201);
    model.answer({ content: "", tool_calls: [call("c1", "listen", {})] });
    await untilCalls(model, 1);
    assert.deepEqual(await (await api("/teacher", "DELETE")).json(), { stopped: true, lesson: true });
    assert.equal((await state()).lesson, null);
    const stayed = await (await api("/teacher")).json();
    assert.equal(stayed.on, true);
    assert.equal(stayed.lesson, null);
    await untilCalls(model, 2); // told the lesson is over
    model.answer({ content: "", tool_calls: [call("c1b", "listen", {})] });
    assert.deepEqual(await (await api("/teacher", "DELETE")).json(), { stopped: true, lesson: false });
    assert.deepEqual(await (await api("/teacher")).json(), { on: false });
    assert.deepEqual(await (await api("/teacher", "DELETE")).json(), { stopped: false, lesson: false });

    // The workspace's lesson taken away by whoever changes it: the lesson ends, the agent stays.
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0 })).status, 201);
    model.answer({ content: "", tool_calls: [call("c2", "listen", {})] });
    await untilCalls(model, 3);
    await api("", "PATCH", { lesson: null });
    await sleep(20);
    const dropped = await (await api("/teacher")).json();
    assert.equal(dropped.on, true);
    assert.equal(dropped.lesson, null);
    // The listen was answered with the news.
    await untilCalls(model, 4);
    assert.match(last(model).said, /The lesson is over: the learner stopped it/);

    // A drill written over it ends the lesson too.
    model.answer({ content: "", tool_calls: [call("c3", "listen", {})] });
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0 })).status, 201);
    model.answer({ content: "", tool_calls: [call("c4", "listen", {})] });
    await api("", "PATCH", { lesson: { mode: "drill", from: 0, to: 1, step: 0 } });
    await sleep(20);
    assert.equal((await (await api("/teacher")).json()).lesson, null);
    await api("", "PATCH", { lesson: null });

    // Another piece opened: the agent goes, and a lesson with it.
    model.answer({ content: "", tool_calls: [call("c5", "listen", {})] });
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0 })).status, 201);
    model.answer({ content: "", tool_calls: [call("c6", "listen", {})] });
    const other = made.scores.find((score) => score.id !== made.state.score.id);
    await api("", "PATCH", { score: { id: other.id } });
    await sleep(20);
    assert.deepEqual(await (await api("/teacher")).json(), { on: false });
    assert.equal((await state()).lesson, null);
  });
});

test("when the model fails the agent waits for the learner and tries again", async () => {
  let calls = 0;
  const model = async () => {
    calls += 1;
    if (calls === 1) throw new Error("the teacher answered 503");
    return { content: "Sorry, where were we." };
  };
  await withTeacher(model, async ({ api, at, made }) => {
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0 })).status, 201);
    const events = await openEvents(`${at}/teacher/events?token=${made.token}&client=test`);
    try {
      let failed;
      do failed = await events.nextOf("status");
      while (failed.status !== "failed");
      assert.deepEqual(failed, { status: "failed", error: "the teacher answered 503" });
      await api("/teacher/say", "POST", { text: "Got it." });
      const say = await events.nextOf("act");
      assert.equal(say.text, "Sorry, where were we.");
      assert.equal(calls, 2);
    } finally {
      events.close();
    }
  });
});

test("the agent without a lesson: a word brings it where the learner is, it sees and works the screen, and a lesson is laid over the same conversation", async () => {
  const model = scriptedModel();
  await withTeacher(model, async ({ api, state, at, made }) => {
    await api("", "PATCH", { time: 4, hands: { left: { show: false, sound: false } } }); // at measure 2, the right hand alone
    const woke = await api("/teacher/say", "POST", { text: "What's this note?" });
    assert.equal(woke.status, 200);
    assert.deepEqual(await woke.json(), { heard: true, woke: true });
    const status = await (await api("/teacher")).json();
    assert.equal(status.on, true);
    assert.equal(status.lesson, null);
    assert.deepEqual(status.transcript, [{ n: 0, who: "learner", text: "What's this note?" }]);
    const set = await state();
    assert.equal(set.lesson, null, "no lesson is written");
    assert.equal(set.time, 4, "nothing on the screen changes");
    assert.equal(set.camera.view.elevation, 72);
    assert.equal(set.hands.left.show, false);

    // What the model was asked: who it is, its (empty) notes, the piece, the brief for the measures they are at, their words with the screen.
    await sleep(20);
    assert.equal(model.calls.length, 1);
    const [system, opening] = model.calls[0].messages;
    assert.equal(system.role, "system");
    assert.match(system.content, /You do not teach unless they ask you to/);
    assert.match(system.content, /About the person:\n\(nothing yet\)\n\nAbout this workspace:\n\(nothing yet\)/);
    assert.match(system.content, /The piece is "Minor Descent": measures 1 to 4\. The score's tempo is 80/);
    assert.match(system.content, /Measures 2 to 4 of "Minor Descent"/, "the brief for the measures they are at");
    assert.doesNotMatch(system.content, /THE LESSON/);
    assert.equal(opening.role, "user");
    assert.match(opening.content, /^What's this note\?\n\(Screen: measure 2, beat 1; right: \w+ on G4; left: [\w ,+]+; not playing; right hand only; tempo 80\)$/);
    assert.deepEqual(model.calls[0].tools, COMPANY_TOOLS);

    const events = await openEvents(`${at}/teacher/events?token=${made.token}&client=test`);
    try {
      // Plain words are spoken; then it listens.
      model.answer({ content: "Pointer finger on G." });
      const say = await events.nextOf("act");
      assert.equal(say.text, "Pointer finger on G.");
      await api("/teacher/done", "POST", { id: say.id, result: { spoken: true } });
      assert.equal((await events.nextOf("status")).status, "listening");

      // The learner moves on and speaks again: their words carry where they are now.
      await api("", "PATCH", { time: 8 });
      assert.deepEqual(await (await api("/teacher/say", "POST", { text: "Go to measure four, left hand, slower." })).json(), { heard: true });
      await events.nextOf("status");
      assert.equal(model.calls.length, 2);
      assert.match(model.calls[1].messages.at(-1).content, /^Go to measure four, left hand, slower\.\n\(Screen: measure 3, beat 1;/);

      // The screen tool changes the workspace at once and answers what is there now.
      model.answer({ content: "", tool_calls: [call("c1", "screen", { measure: "4", hands: "left", tempo: 50 }), call("c2", "see", {})] });
      await events.nextOf("status");
      const [changed, seen] = model.calls[2].messages.slice(-2).map((message) => JSON.parse(message.content));
      assert.deepEqual(changed.changed, ["time", "tempo", "hands"]);
      assert.match(changed.screen, /^Screen: measure 4, beat 1; right: \w+ on A3, \w+ on E4; left: [\w ,#+]+; not playing; left hand only; tempo 50$/);
      assert.match(seen.camera, /^azimuth 0, elevation 72, zoom 1$/);
      assert.equal(seen.numbers, "finger numbers shown");
      const now = await state();
      assert.equal(now.time, 12);
      assert.equal(now.tempo, 50);
      assert.deepEqual(now.hands, { left: { show: true, sound: true }, right: { show: false, sound: false } });

      // A measure the piece does not have: an error, and nothing changes.
      model.answer({ content: "", tool_calls: [call("c3", "screen", { measure: "99", tempo: 0 })] });
      await events.nextOf("status");
      assert.match(last(model).error, /No such measure/);
      assert.equal((await state()).tempo, 50);

      // The camera, the passage Play keeps to, the look of the stage, the score's own tempo.
      model.answer({ content: "", tool_calls: [call("c4", "screen", { camera: { view: "overhead" }, passage: { from_measure: "2", to_measure: "3", times: 0 }, look: { scene: "park" }, tempo: 0 })] });
      await events.nextOf("status");
      const after = await state();
      assert.equal(after.camera.view.elevation, 87);
      assert.deepEqual(after.passage, { from: 1, to: 2, times: null });
      assert.equal(after.look.scene, "park");
      assert.equal(after.tempo, null);
      assert.match(last(model).screen, /tempo 80; Play keeps to measures 2 to 3, looped$/);

      // The learner cuts a loop short: their words come with the screen as it is.
      model.answer({ content: "", tool_calls: [call("c5", "play", { from_measure: "2", to_measure: "3", hands: "both", tempo: 60, times: 1, loop: true })] });
      const play = await events.nextOf("act");
      assert.equal(play.type, "play");
      await api("/teacher/say", "POST", { text: "Stop. Teach me these two." });
      await events.nextOf("cut");
      await events.nextOf("status");
      const cut = last(model);
      assert.equal(cut.interrupted, true);
      assert.equal(cut.learner_said, "Stop. Teach me these two.");
      assert.match(cut.screen, /^Screen: /);

      // Teaching: the lesson is laid over the same conversation, with the opening message next.
      model.answer({ content: "", tool_calls: [call("c6", "teach", { from_measure: "2", to_measure: "3", style: "play-along", said: "Teach me these two." })] });
      assert.deepEqual(await events.nextOf("lesson"), { on: true, lesson: { mode: "teacher", from: 1, to: 2, style: "play-along", score: made.state.score.id } });
      await events.nextOf("status");
      const lesson = await (await api("/teacher")).json();
      assert.deepEqual(lesson.lesson, { mode: "teacher", from: 1, to: 2, style: "play-along", score: made.state.score.id });
      assert.deepEqual((await state()).lesson, lesson.lesson);
      assert.equal(model.calls.length, 7);
      const asked = model.calls[6];
      assert.deepEqual(asked.tools, TEACHING_TOOLS);
      assert.match(asked.messages[0].content, /THE WAY OF TEACHING ASKED FOR: Play along/);
      assert.match(asked.messages[0].content, /THE PASSAGE OF THE LESSON\nMeasures 2 to 3/);
      assert.match(asked.messages.at(-1).content, /^The learner has chosen measures 2 to 3 and the way of teaching "Play along"\. They said: "Teach me these two\." Begin\.\n\(Screen: /);
      assert.match(JSON.parse(asked.messages.at(-2).content).lesson, /^begun on measures 2 to 3/);
      assert.equal(asked.messages.length, model.calls[5].messages.length + 3, "assistant, tool, opening: the conversation runs on");
      assert.equal(asked.messages[1].content, model.calls[0].messages[1].content, "from its first word");
    } finally {
      events.close();
    }
  });
});

test("the agent stays through lessons, and the screen is left as the learner has it when it goes", async () => {
  const model = scriptedModel();
  await withTeacher(model, async ({ api, state }) => {
    await api("", "PATCH", { tempo: 50, hands: { left: { show: false, sound: false } } });
    assert.deepEqual(await (await api("/teacher/say", "POST", { text: "Hi." })).json(), { heard: true, woke: true });
    model.answer({ content: "", tool_calls: [call("c1", "listen", {})] });
    await untilCalls(model, 1);
    // A lesson started from outside over it: the same agent, now teaching; a word goes to it as the teacher.
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0 })).status, 201);
    await untilCalls(model, 2);
    assert.match(last(model).said, /^The learner has chosen measure 1/, "the listen was answered with the opening");
    assert.deepEqual(model.calls[1].tools, TEACHING_TOOLS);
    model.answer({ content: "", tool_calls: [call("c2", "listen", {})] });
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0 })).status, 409);
    assert.deepEqual(await (await api("/teacher/say", "POST", { text: "Got it." })).json(), { heard: true });
    await untilCalls(model, 3);
    model.answer({ content: "", tool_calls: [call("c3", "listen", {})] });
    assert.deepEqual(await (await api("/teacher", "DELETE")).json(), { stopped: true, lesson: true });
    assert.deepEqual((await state()).hands, { left: { show: true, sound: true }, right: { show: true, sound: true } }, "a lesson's end puts the piece back");
    // Sent away with no lesson on: nothing is put back.
    await api("", "PATCH", { tempo: 50, hands: { left: { show: false, sound: false } } });
    assert.deepEqual(await (await api("/teacher", "DELETE")).json(), { stopped: true, lesson: false });
    assert.deepEqual(await (await api("/teacher")).json(), { on: false });
    const kept = await state();
    assert.equal(kept.tempo, 50);
    assert.equal(kept.hands.left.show, false);
    // Nothing said is nothing heard.
    assert.equal((await api("/teacher/say", "POST", { text: "  " })).status, 400);
    assert.deepEqual(await (await api("/teacher")).json(), { on: false });
  });
});

test("a conversation gone cold is dropped and begun afresh, not sent again; the session, the lesson and the transcript stay", async () => {
  const model = scriptedModel();
  await withTeacher(
    model,
    async ({ api, at, made }) => {
      const events = await openEvents(`${at}/teacher/events?token=${made.token}&client=test`).catch(() => null);
      assert.equal(events, null, "no agent yet");
      await api("/teacher/say", "POST", { text: "Hi there." });
      await sleep(20);
      model.answer({ content: "Hello." });
      const stream = await openEvents(`${at}/teacher/events?token=${made.token}&client=test`);
      try {
        const hello = await stream.nextOf("act");
        await api("/teacher/done", "POST", { id: hello.id, result: { spoken: true } });
        await stream.nextOf("status");
        // Straight away: the conversation goes on.
        await api("/teacher/say", "POST", { text: "Measure two." });
        await stream.nextOf("status");
        assert.equal(model.calls[1].messages.length, 4, "system, Hi, Hello, Measure two");
        model.answer({ content: "There." });
        const there = await stream.nextOf("act");
        await api("/teacher/done", "POST", { id: there.id, result: { spoken: true } });
        await stream.nextOf("status");
        // After a while: dropped, and begun again from the system prompt with what was said since.
        await sleep(120);
        await api("/teacher/say", "POST", { text: "Still there?" });
        await stream.nextOf("status");
        assert.equal(model.calls.length, 3);
        const fresh = model.calls[2].messages;
        assert.equal(fresh.length, 2, "the old conversation is not sent again");
        assert.equal(fresh[0].role, "system");
        assert.match(fresh[1].content, /^\(This conversation is new: the one before was dropped while the learner was away a while\./);
        assert.match(fresh[1].content, /\nStill there\?\n\(Screen: measure 1/);
        assert.doesNotMatch(fresh[1].content, /A lesson is under way/);
        const status = await (await api("/teacher")).json();
        assert.equal(status.transcript.length, 5, "the transcript on the panel keeps everything");
        model.answer({ content: "Yes." });
        const yes = await stream.nextOf("act");
        await api("/teacher/done", "POST", { id: yes.id, result: { spoken: true } });
        await stream.nextOf("status");

        // The same in a lesson, while the agent waits with listen: the lesson is kept, and said so.
        await api("/teacher", "POST", { from: 0, to: 1, style: "lead" });
        await stream.nextOf("status");
        assert.equal(model.calls[3].messages.length, 4, "the lesson begins in the running conversation: system, the fresh start, Yes, the opening");
        model.answer({ content: "", tool_calls: [call("c1", "listen", {})] });
        await stream.nextOf("status");
        await sleep(120);
        await api("/teacher/say", "POST", { text: "Got it." });
        await stream.nextOf("status");
        const resumed = model.calls[4].messages;
        assert.equal(resumed.length, 2);
        assert.match(resumed[0].content, /THE LESSON/);
        assert.match(resumed[1].content, /A lesson is under way \(see THE LESSON\)/);
        assert.match(resumed[1].content, /\nGot it\.\n/);
        assert.deepEqual(model.calls[4].tools, TEACHING_TOOLS);
        assert.deepEqual((await (await api("/teacher")).json()).lesson, { mode: "teacher", from: 0, to: 1, style: "lead", score: made.state.score.id });
      } finally {
        stream.close();
      }
    },
    { stale: 80 },
  );
});

test("the agent's notes: about the person and about the workspace, written by it, read into every new conversation, following copies of the workspace", async () => {
  const model = scriptedModel();
  await withTeacher(model, async ({ api, base, made }) => {
    assert.deepEqual(await (await api("/notes")).json(), { person: "", workspace: "" });
    await api("/teacher/say", "POST", { text: "I like it slow. I'm working on the left hand of measure two." });
    await untilCalls(model, 1);
    model.answer({ content: "", tool_calls: [call("c1", "remember", { about: "person", notes: "Likes a slow tempo to start." }), call("c2", "remember", { about: "workspace", notes: "Minor Descent: working on the left hand of measure 2." }), call("c3", "remember", { about: "elsewhere", notes: "x" })] });
    await untilCalls(model, 2);
    const [person, workspace, wrong] = model.calls[1].messages.slice(-3).map((message) => JSON.parse(message.content));
    assert.deepEqual(person, { kept: true, about: "person", length: 28 });
    assert.equal(workspace.kept, true);
    assert.match(wrong.error, /about must be person or workspace/);
    assert.deepEqual(await (await api("/notes")).json(), { person: "Likes a slow tempo to start.", workspace: "Minor Descent: working on the left hand of measure 2." });
    model.answer({ content: "", tool_calls: [call("c4", "listen", {})] });

    // A new conversation reads them.
    assert.deepEqual(await (await api("/teacher", "DELETE")).json(), { stopped: true, lesson: false });
    await api("/teacher/say", "POST", { text: "Back." });
    await untilCalls(model, 3);
    assert.match(model.calls[2].messages[0].content, /About the person:\nLikes a slow tempo to start\.\n\nAbout this workspace:\nMinor Descent: working on the left hand of measure 2\./);
    model.answer({ content: "", tool_calls: [call("c5", "listen", {})] });

    // Set from outside: the running conversation is left alone, the next reads them.
    assert.deepEqual(await (await api("/notes", "PATCH", { person: "Prefers to be called Cal." })).json(), { person: "Prefers to be called Cal.", workspace: "Minor Descent: working on the left hand of measure 2." });
    assert.deepEqual((await (await api("/notes", "PATCH", { person: 5 })).json()).person, "Prefers to be called Cal.", "a note that is not text is ignored");

    // A copy of the workspace is the same person's, with the same notes; a workspace made afresh is somebody else's.
    const copy = await (await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Try", copyFrom: { id: made.id, token: made.token } }) })).json();
    const copied = await (await fetch(`${base}/api/workspaces/${copy.id}/notes`, { headers: { authorization: `Bearer ${copy.token}` } })).json();
    assert.deepEqual(copied, { person: "Prefers to be called Cal.", workspace: "Minor Descent: working on the left hand of measure 2." });
    const fresh = await (await fetch(`${base}/api/workspaces`, { method: "POST", body: "{}" })).json();
    assert.deepEqual(await (await fetch(`${base}/api/workspaces/${fresh.id}/notes`, { headers: { authorization: `Bearer ${fresh.token}` } })).json(), { person: "", workspace: "" });
    assert.ok(!("owner" in copy) && !("notes" in copy), "the person's id and the notes are not in the connection details");
  });
});

test("the site says what it has; without a teacher or ears the routes say so; the ears hear a recording", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "musichands-"));
  const server = createAppServer(undefined, { dataDir, model: null, speak: null, hear: null });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const base = `http://localhost:${server.address().port}`;
    const made = await (await fetch(`${base}/api/workspaces`, { method: "POST", body: "{}" })).json();
    const headers = { authorization: `Bearer ${made.token}`, "content-type": "application/json" };
    const doc = await (await fetch(`${base}/api/workspaces/${made.id}`, { headers })).json();
    assert.deepEqual(doc.site, { voice: false, teacher: false, ears: false });
    assert.equal((await fetch(`${base}/api/workspaces/${made.id}/teacher`, { headers })).status, 503);
    assert.equal((await fetch(`${base}/api/workspaces/${made.id}/hear`, { method: "POST", headers: { ...headers, "content-type": "audio/webm" }, body: "xx" })).status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
  const heard = [];
  const hear = async (audio, mime) => {
    heard.push([audio.toString(), mime]);
    return "  Thumb on A, please.  ";
  };
  await withTeacher(scriptedModel(), async ({ api, base, made }) => {
    const doc = await (await api("")).json();
    assert.deepEqual(doc.site, { voice: false, teacher: true, ears: true });
    const answer = await fetch(`${base}/api/workspaces/${made.id}/hear`, { method: "POST", headers: { authorization: `Bearer ${made.token}`, "content-type": "audio/webm;codecs=opus" }, body: "opus bytes" });
    assert.deepEqual(await answer.json(), { text: "Thumb on A, please." });
    assert.deepEqual(heard, [["opus bytes", "audio/webm;codecs=opus"]]);
    assert.equal((await fetch(`${base}/api/workspaces/${made.id}/hear`, { method: "POST", headers: { authorization: `Bearer ${made.token}` } })).status, 400);
  }, { hear });
});

test("the OpenRouter model sends the conversation and the tools, marks where it may be cached, and asks again once when refused for being busy", async () => {
  const { openRouterModel } = await import("../server.js");
  assert.equal(openRouterModel({ key: "" }), null, "no key, no teacher");
  const seen = [];
  let busy = true;
  const request = async (url, options) => {
    seen.push({ url, options });
    if (busy) {
      busy = false;
      return new Response("slow down", { status: 429 });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "Hello.", tool_calls: [call("x", "listen", {})] } }] });
  };
  const model = openRouterModel({ key: "sk-test", model: "some/model", request, wait: async () => {} });
  assert.equal(model.label, "openrouter/some/model");
  const answer = await model([{ role: "system", content: "Teach." }, { role: "user", content: "Hi." }], TOOLS);
  assert.equal(answer.content, "Hello.");
  assert.equal(answer.tool_calls[0].function.name, "listen");
  assert.equal(seen.length, 2, "once refused, asked again");
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seen[0].options.headers.authorization, "Bearer sk-test");
  const body = JSON.parse(seen[0].options.body);
  assert.equal(body.model, "some/model");
  const mark = (text) => [{ type: "text", text, cache_control: { type: "ephemeral" } }];
  assert.deepEqual(body.messages, [{ role: "system", content: mark("Teach.") }, { role: "user", content: mark("Hi.") }]);
  assert.equal(body.tools.length, TOOLS.length);
  assert.equal(body.tool_choice, "auto");
  const refusing = openRouterModel({ key: "sk-test", request: async () => new Response('{"error":{"message":"no such model"}}', { status: 400 }) });
  await assert.rejects(refusing([], []), /the teacher answered 400: .*no such model/);

  // The marks: the system prompt and the learner's latest words; the rest as it was.
  const marked = cacheMarked([{ role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "", tool_calls: [] }, { role: "tool", tool_call_id: "1", content: "{}" }, { role: "user", content: "b" }, { role: "assistant", content: "c" }]);
  assert.deepEqual(marked.map((message) => (Array.isArray(message.content) ? "marked" : message.content)), ["marked", "a", "", "{}", "marked", "c"]);
});

test("the ElevenLabs ears send the recording as a file and answer the words", async () => {
  const { elevenLabsEars } = await import("../server.js");
  assert.equal(elevenLabsEars({ key: "" }), null);
  let got;
  const request = async (url, options) => {
    got = { url, headers: options.headers, form: options.body };
    return Response.json({ text: "Thumb on A." });
  };
  const hear = elevenLabsEars({ key: "xi-test", request });
  assert.equal(await hear(Buffer.from("opus"), "audio/webm;codecs=opus"), "Thumb on A.");
  assert.equal(got.url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(got.headers["xi-api-key"], "xi-test");
  assert.equal(got.form.get("model_id"), "scribe_v1");
  const file = got.form.get("file");
  assert.equal(file.name, "speech.webm");
  assert.equal(file.type, "audio/webm;codecs=opus");
  assert.equal(await file.text(), "opus");
});
