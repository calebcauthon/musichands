import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAppServer, resolveFile, serve } from "../server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("serves the app's own files and nothing else", () => {
  assert.equal(resolveFile("/"), path.join(ROOT, "index.html"));
  assert.equal(resolveFile("/studio.html?v=3"), path.join(ROOT, "studio.html"));
  assert.equal(resolveFile("/assets/piano/C4.mp3"), path.join(ROOT, "assets", "piano", "C4.mp3"));
  for (const hidden of ["/.git/config", "/.serena/project.yml", "/assets/../.git/HEAD", "/../secret.js", "/%2e%2e/%2e%2e/etc/passwd", "/test/server.test.js", "/server.js", "/package.json", "/private/score.musicxml", "/scores/minor-descent.musicxml", "/scores/starter.json", "/notes.txt", "/assets/%00.js", "/%E0%A4%A"]) {
    assert.equal(resolveFile(hidden), null, hidden);
  }
});

test("answers requests with the right kind of file", async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const front = await page.text();
    assert.match(front, /id="score-container"/, "the front page is the sheet music");
    assert.match(front, /href="\.\/studio\.html"/, "and it links to the studio");
    assert.match(await (await fetch(`${base}/studio.html`)).text(), /id="visual-stage"/);
    assert.match(await (await fetch(`${base}/sheet.html`)).text(), /url=\.\//, "the old address sends visitors to the front page");
    const script = await fetch(`${base}/hand-stage.js`);
    assert.match(script.headers.get("content-type"), /text\/javascript/, "modules only load as JavaScript");
    const model = await fetch(`${base}/assets/hand-right.glb`);
    assert.equal(model.headers.get("content-type"), "model/gltf-binary");
    assert.ok((await model.arrayBuffer()).byteLength > 50000);
    assert.equal((await fetch(`${base}/.git/config`)).status, 404);
    assert.equal((await fetch(`${base}/nothing-here.js`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("asked to find a port, the server takes the next free one", async () => {
  const taken = createAppServer();
  await new Promise((resolve) => taken.listen(0, resolve));
  const busy = taken.address().port;
  const server = createAppServer();
  try {
    const chosen = await serve(server, busy, { findPort: true });
    assert.equal(chosen, busy + 1);
    await assert.rejects(serve(createAppServer(), busy), /EADDRINUSE/, "without the flag a busy port is an error");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => taken.close(resolve));
  }
});
