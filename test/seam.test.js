// The learning module sits behind a seam: it may change freely without the
// page, the workspace or the server knowing, and they may not reach into it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const imports = (text) => [...text.matchAll(/^import .* from "(.+)";$/gm), ...text.matchAll(/^export .* from "(.+)";$/gm)].map((match) => match[1]);

test("learning uses only its own files, the passage arithmetic and the app it is handed", async () => {
  assert.deepEqual(imports(await source("learning.js")).sort(), ["./lesson.js", "./speech.js", "./teaching-styles.js"]);
  assert.deepEqual(imports(await source("lesson.js")).sort(), ["./passage.js", "./teaching-styles.js"]);
  assert.deepEqual(imports(await source("teaching-styles.js")), []);
  assert.deepEqual(imports(await source("speech.js")), []);
  assert.deepEqual(imports(await source("teacher.js")).sort(), ["./corrections.js", "./lesson.js", "./teaching-styles.js"], "the teacher shares the lesson's files with the page, and knows corrections");
  const learning = (await source("learning.js")).replace(/\/\/.*$/gm, ""); // the code, without its comments
  assert.doesNotMatch(learning, /\bws\b|\bpage\.|transport|handsView|musichands/, "nothing of the page's insides");
});

test("the page mounts learning and otherwise knows nothing of lessons", async () => {
  const sheet = await source("sheet.js");
  assert.deepEqual(imports(sheet).filter((name) => /lesson|learning|speech/.test(name)), ["./learning.js"]);
  const mentions = sheet.split("\n").filter((line) => /lesson|learn/i.test(line) && !/mountLearning|learning\.js/.test(line));
  assert.deepEqual(mentions, [], "no lesson logic in the page");
});

test("the workspace, the server and the transport do not read lessons; the server only keeps the teacher", async () => {
  for (const name of ["workspace-model.js", "workspace-client.js", "score-transport.js", "passage.js"]) {
    assert.deepEqual(imports(await source(name)).filter((from) => /lesson|learning|teach/.test(from)), [], name);
  }
  const server = await source("server.js");
  assert.deepEqual(imports(server).filter((from) => /lesson|learning|teach/.test(from)), ["./teacher.js"]);
  assert.doesNotMatch(server.replace(/\/\/.*$/gm, ""), /state\.lesson\b/, "the server never reads the lesson itself");
  const model = await source("workspace-model.js");
  assert.equal(model.split("\n").filter((line) => /lesson/.test(line)).length, 2, "the state has a place for the lesson, and keeps it as given: nothing more");
  assert.doesNotMatch(await source("score-transport.js"), /lesson/i);
});
