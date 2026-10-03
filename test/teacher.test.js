// The teacher over HTTP, with a model that answers what the test tells it
// to: a lesson is started, the teacher's acts reach the screen and their
// results reach the model, the learner's words cut acts short, fingerings
// change, and the lesson ends.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../server.js";
import { TOOLS } from "../teacher.js";

// A model whose every answer the test hands it, and which keeps what it was asked.
function scriptedModel() {
  const waiting = []; // calls waiting for an answer
  const answers = []; // answers waiting for a call
  const model = async (messages, tools) => {
    model.calls.push({ messages, tools });
    if (answers.length) return answers.shift();
    return new Promise((resolve) => waiting.push(resolve));
  };
  model.calls = [];
  model.answer = (reply) => (waiting.length ? waiting.shift()(reply) : answers.push(reply));
  model.label = "test";
  return model;
}
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

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

async function withTeacher(model, body, { hear = null } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "musichands-"));
  const server = createAppServer(undefined, { dataDir, model, speak: null, hear });
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

test("a lesson: the teacher's acts reach the screen, their results reach the model, the learner cuts in, the lesson ends", async () => {
  const model = scriptedModel();
  await withTeacher(model, async ({ api, state, at, made }) => {
    assert.deepEqual((await (await api("/teacher")).json()), { on: false });
    assert.equal((await api("/teacher/say", "POST", { text: "hello?" })).status, 404, "no lesson to talk to yet");

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
      // What the model was asked.
      assert.equal(model.calls.length, 1);
      const [system, opening] = model.calls[0].messages;
      assert.equal(system.role, "system");
      assert.match(system.content, /Right hand alone/, "the way of teaching");
      assert.match(system.content, /RIGHT HAND\nSits at the start with/, "the brief");
      assert.match(system.content, /The score's tempo is \d+ beats a minute/);
      assert.equal(opening.role, "user");
      assert.match(opening.content, /measures 1 to 2 .* "Hands separate, then together, then faster"\. They said: "You lead the way\."/);
      assert.deepEqual(model.calls[0].tools, TOOLS);

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
      assert.deepEqual(model.calls[2].messages.at(-1), { role: "user", content: "Got it." });

      // A loop plays until the learner speaks; what they say comes back as the tool's answer.
      model.answer({ content: "", tool_calls: [call("c3", "play", { from_measure: "1", to_measure: "2", until_moment: "", hands: "right", tempo: 40, times: 1, loop: true }), call("c4", "say", { text: "Keep going." })] });
      const play = await events.nextOf("act");
      assert.deepEqual(play, { id: "4", type: "play", from: 0, to: 1, start: null, end: null, hands: "right", tempo: 40, times: null, loop: true });
      await api("/teacher/say", "POST", { text: "Too fast, slow down." });
      assert.deepEqual(await events.nextOf("cut"), { id: "4" });
      await events.nextOf("status");
      assert.equal(model.calls.length, 4);
      const [played, skipped] = model.calls[3].messages.slice(-2).map((message) => JSON.parse(message.content));
      assert.deepEqual(played, { interrupted: true, learner_said: "Too fast, slow down." });
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
      const last = await events.nextOf("act");
      assert.equal(last.start, 4, "from the right hand's moment at measure 2");
      assert.equal(last.end, null, "its note lasts to the end of the measures, so the end is the passage's");
      await api("/teacher/done", "POST", { id: last.id, result: { played: true } });
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

      // A wrong moment is an error the model can read.
      model.answer({ content: "", tool_calls: [call("c8", "play_moment", { moment: "9:9", hands: "both" })] });
      await events.nextOf("status");
      assert.match(JSON.parse(model.calls[8].messages.at(-1).content).error, /No moment 9:9/);

      // Done: the last word is spoken, then the piece is put back.
      model.answer({ content: "", tool_calls: [call("c9", "done", { closing: "That's it for today." })] });
      const closing = await events.nextOf("act");
      assert.equal(closing.text, "That's it for today.");
      await api("/teacher/done", "POST", { id: closing.id, result: { spoken: true } });
      assert.deepEqual(await events.nextOf("ended"), { reason: "done" });
      const after = await state();
      assert.equal(after.lesson, null);
      assert.equal(after.passage, null);
      assert.deepEqual(after.hands, { left: { show: true, sound: true }, right: { show: true, sound: true } });
      assert.deepEqual(await (await api("/teacher")).json(), { on: false });
      assert.equal(model.calls.length, 9, "the model is not asked again once the lesson is done");
    } finally {
      events.close();
    }
  });
});

test("a lesson ends when it is stopped, when the workspace drops it, and when the piece changes", async () => {
  const model = scriptedModel();
  await withTeacher(model, async ({ api, state, made }) => {
    // Stopped from outside.
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0, style: "lead" })).status, 201);
    model.answer({ content: "", tool_calls: [call("c1", "listen", {})] });
    assert.deepEqual(await (await api("/teacher", "DELETE")).json(), { stopped: true });
    assert.equal((await state()).lesson, null);
    assert.deepEqual(await (await api("/teacher")).json(), { on: false });
    assert.deepEqual(await (await api("/teacher", "DELETE")).json(), { stopped: false });

    // The workspace's lesson taken away by whoever changes it.
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0 })).status, 201);
    model.answer({ content: "", tool_calls: [call("c2", "listen", {})] });
    await api("", "PATCH", { lesson: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await (await api("/teacher")).json(), { on: false });

    // Another piece opened.
    assert.equal((await api("/teacher", "POST", { from: 0, to: 0 })).status, 201);
    model.answer({ content: "", tool_calls: [call("c3", "listen", {})] });
    const other = made.scores.find((score) => score.id !== made.state.score.id);
    await api("", "PATCH", { score: { id: other.id } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await (await api("/teacher")).json(), { on: false });
    assert.equal((await state()).lesson, null);
  });
});

test("when the model fails the lesson waits for the learner and tries again", async () => {
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
      const failed = await events.nextOf("status");
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

test("the OpenRouter model sends the conversation and the tools, and asks again once when refused for being busy", async () => {
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
  const answer = await model([{ role: "system", content: "Teach." }], TOOLS);
  assert.equal(answer.content, "Hello.");
  assert.equal(answer.tool_calls[0].function.name, "listen");
  assert.equal(seen.length, 2, "once refused, asked again");
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seen[0].options.headers.authorization, "Bearer sk-test");
  const body = JSON.parse(seen[0].options.body);
  assert.equal(body.model, "some/model");
  assert.deepEqual(body.messages, [{ role: "system", content: "Teach." }]);
  assert.equal(body.tools.length, TOOLS.length);
  assert.equal(body.tool_choice, "auto");
  const refusing = openRouterModel({ key: "sk-test", request: async () => new Response('{"error":{"message":"no such model"}}', { status: 400 }) });
  await assert.rejects(refusing([], []), /the teacher answered 400: .*no such model/);
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
