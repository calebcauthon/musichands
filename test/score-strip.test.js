import assert from "node:assert/strict";
import test from "node:test";
import { bandAt, stripHeight, stripScroll, systemBands } from "../score-strip.js";

// Three lines of music, their staves 120 tall, in a drawing 700 tall.
const systems = [{ top: 60, bottom: 180 }, { top: 280, bottom: 400 }, { top: 520, bottom: 640 }];

test("every line of music gets a band, and the bands cover the whole drawing", () => {
  const bands = systemBands(systems, 700);
  assert.deepEqual(bands, [{ top: 0, bottom: 230 }, { top: 230, bottom: 460 }, { top: 460, bottom: 700 }]);
  // A piece on one line is one band, as tall as the drawing.
  assert.deepEqual(systemBands([systems[0]], 260), [{ top: 0, bottom: 260 }]);
  assert.deepEqual(systemBands([], 260), []);
});

test("a height in the drawing belongs to the line whose band it is in", () => {
  const bands = systemBands(systems, 700);
  assert.equal(bandAt(bands, 120), 0);
  assert.equal(bandAt(bands, 229), 0);
  assert.equal(bandAt(bands, 231), 1);
  assert.equal(bandAt(bands, 580), 2);
  assert.equal(bandAt(bands, -40), 0, "above the first line is the first line");
  assert.equal(bandAt(bands, 900), 2, "below the last line is the last line");
});

test("the strip is as tall as the tallest line, up to a limit", () => {
  const bands = systemBands(systems, 700);
  assert.equal(stripHeight(bands), 240);
  assert.equal(stripHeight(bands, 200), 200);
  assert.equal(stripHeight([]), 0);
});

test("the strip scrolls to put the line being played in its middle", () => {
  const bands = systemBands(systems, 700);
  assert.equal(stripScroll(bands[0], 240), 0, "the first line needs no scrolling");
  assert.equal(stripScroll(bands[1], 240), 225);
  assert.equal(stripScroll(bands[2], 240), 460);
  // A strip shorter than the line shows the middle of it, where the staves are.
  assert.equal(stripScroll(bands[1], 200), 245);
});
