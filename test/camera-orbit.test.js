import assert from "node:assert/strict";
import test from "node:test";
import { dragOrbit, framingDistance, ORBIT_LIMITS, orbitPosition, readView, sameView, zoomView } from "../camera-orbit.js";

const close = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < 1e-9);

test("the camera keeps its distance from the hands wherever it is turned", () => {
  const target = [0.2, 0.018, -0.002];
  for (const view of [{ azimuth: 0, elevation: 72 }, { azimuth: 90, elevation: 20 }, { azimuth: -135, elevation: 45 }, { azimuth: 30, elevation: 89 }]) {
    const position = orbitPosition(target, 0.6, view);
    const distance = Math.hypot(...position.map((value, index) => value - target[index]));
    assert.ok(Math.abs(distance - 0.6) < 1e-9);
    assert.ok(position[1] > target[1], "the camera stays above the keys");
  }
});

test("the starting view looks from the player's side", () => {
  assert.ok(close(orbitPosition([0, 0, 0], 1, { azimuth: 0, elevation: 0 }), [0, 0, 1]));
  assert.ok(close(orbitPosition([0, 0, 0], 1, { azimuth: 90, elevation: 0 }), [1, 0, 0]));
  assert.ok(close(orbitPosition([0, 0, 0], 2, { azimuth: 0, elevation: 90 }), [0, 2, 0]));
});

test("dragging turns the view and stops at the limits", () => {
  const start = { azimuth: 0, elevation: 72 };
  const right = dragOrbit(start, 100, 0);
  assert.ok(right.azimuth < 0 && right.elevation === 72, "dragging right swings the camera left");
  assert.ok(dragOrbit(start, 0, -100).elevation < 72, "dragging up lowers the camera");
  assert.deepEqual(dragOrbit(start, 0, 5000), { azimuth: 0, elevation: ORBIT_LIMITS.elevation[1], zoom: 1 });
  assert.deepEqual(dragOrbit({ ...start, zoom: 1.5 }, -5000, -5000), { azimuth: ORBIT_LIMITS.azimuth[1], elevation: ORBIT_LIMITS.elevation[0], zoom: 1.5 });
});

test("a stored view is only used if it makes sense", () => {
  assert.deepEqual(readView('{"azimuth":40,"elevation":30}'), { azimuth: 40, elevation: 30, zoom: 1 });
  assert.deepEqual(readView('{"azimuth":900,"elevation":-4,"zoom":50}'), { azimuth: ORBIT_LIMITS.azimuth[1], elevation: ORBIT_LIMITS.elevation[0], zoom: ORBIT_LIMITS.zoom[1] });
  assert.equal(readView("not json"), null);
  assert.equal(readView('{"azimuth":"left"}'), null);
  assert.equal(readView(null), null);
  assert.ok(sameView({ azimuth: 0, elevation: 72 }, { azimuth: 0.2, elevation: 71.8 }));
  assert.ok(!sameView({ azimuth: 0, elevation: 72 }, { azimuth: 12, elevation: 72 }));
});

test("the camera backs away when turning would push the hands out of frame", () => {
  const patch = { width: 0.9, depth: 0.29 };
  const lens = { vertical: 27, aspect: 3 };
  const home = framingDistance(patch, { azimuth: 0, elevation: 72 }, lens);
  const side = framingDistance(patch, { azimuth: 90, elevation: 72 }, lens);
  assert.ok(side > home * 1.5, "from the side the keyboard runs away from the camera and needs more room");
  assert.ok(Math.abs(framingDistance(patch, { azimuth: -90, elevation: 72 }, lens) - side) < 1e-9, "left and right are alike");
  // Seen from the front at the starting angle, the patch exactly fills the taller of the two fits.
  const halfHeight = Math.tan((27 * Math.PI) / 360);
  assert.ok(Math.abs(home - Math.max(0.9 / (2 * halfHeight * 3), (0.29 * Math.sin((72 * Math.PI) / 180)) / (2 * halfHeight))) < 1e-9);
});

test("the camera moves closer and farther, within limits", () => {
  const start = { azimuth: 20, elevation: 40, zoom: 1 };
  const closer = zoomView(start, 1.2);
  assert.deepEqual(closer, { azimuth: 20, elevation: 40, zoom: 1.2 });
  assert.ok(zoomView(start, 1 / 1.2).zoom < 1);
  assert.equal(zoomView(start, 100).zoom, ORBIT_LIMITS.zoom[1]);
  assert.equal(zoomView(start, 0.001).zoom, ORBIT_LIMITS.zoom[0]);
  assert.ok(!sameView(start, closer), "a closer view is a different view");
});
