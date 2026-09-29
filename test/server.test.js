import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAppServer, resolveFile } from "../server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("serves the app's own files and nothing else", () => {
  assert.equal(resolveFile("/"), path.join(ROOT, "index.html"));
  assert.equal(resolveFile("/sheet.html?v=3"), path.join(ROOT, "sheet.html"));
  assert.equal(resolveFile("/assets/piano/C4.mp3"), path.join(ROOT, "assets", "piano", "C4.mp3"));
  for (const hidden of ["/.git/config", "/.serena/project.yml", "/assets/../.git/HEAD", "/../secret.js", "/%2e%2e/%2e%2e/etc/passwd", "/test/server.test.js", "/server.js", "/package.json", "/private/score.musicxml", "/notes.txt", "/assets/%00.js", "/%E0%A4%A"]) {
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
    assert.match(await page.text(), /MusicHands/);
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
