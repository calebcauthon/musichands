import assert from "node:assert/strict";
import test from "node:test";
import { cleanLook, defaultLook, LOOK_KINDS, LOOKS, specsFor } from "../looks.js";

test("every kind of look has a default that exists, with a label", () => {
  const look = defaultLook();
  for (const kind of LOOK_KINDS) {
    assert.ok(LOOKS[kind][look[kind]], `${kind}: ${look[kind]}`);
    for (const [name, spec] of Object.entries(LOOKS[kind])) assert.ok(spec.label, `${kind}.${name} has no label`);
  }
});

test("a look is cleaned to names that exist", () => {
  assert.deepEqual(cleanLook(null), defaultLook());
  assert.deepEqual(cleanLook({ scene: "park", gloves: "white", piano: "no such piano", build: 7 }), { ...defaultLook(), scene: "park", gloves: "white" });
});

test("specs carry their name and their kind's fields", () => {
  const specs = specsFor({ outfit: "clown", scene: "hall" });
  assert.equal(specs.outfit.name, "clown");
  assert.ok(specs.outfit.dots, "the clown has spots");
  assert.equal(specs.scene.set, "hall");
  assert.equal(specs.build.name, "man");
  assert.ok(specs.build.woman === undefined);
});
