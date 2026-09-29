import assert from "node:assert/strict";
import test from "node:test";
import { applyChoices, defaultChoices, readChoices } from "../hand-choices.js";

const moment = {
  left: { sounding: [36, 43], struck: [{ midi: 36 }] }, // 43 is tied over
  right: { sounding: [60, 64], struck: [{ midi: 60 }, { midi: 64 }] },
};
const mids = (notes) => notes.map((note) => note.midi);

test("with nothing switched off, both hands are drawn and heard", () => {
  const { shown, ghost, heard } = applyChoices(moment, defaultChoices());
  assert.deepEqual(shown, ["left", "right"]);
  assert.deepEqual(ghost, { held: [], struck: [] });
  assert.deepEqual(mids(heard), [36, 60, 64]);
});

test("a hidden hand leaves its keys going down on their own, and is still heard", () => {
  const choices = defaultChoices();
  choices.left.show = false;
  const { shown, ghost, heard } = applyChoices(moment, choices);
  assert.deepEqual(shown, ["right"]);
  assert.deepEqual(ghost, { held: [43], struck: [36] });
  assert.deepEqual(mids(heard), [36, 60, 64]);
});

test("a silenced hand is still drawn", () => {
  const choices = defaultChoices();
  choices.right.sound = false;
  const { shown, ghost, heard } = applyChoices(moment, choices);
  assert.deepEqual(shown, ["left", "right"]);
  assert.deepEqual(ghost.struck, []);
  assert.deepEqual(mids(heard), [36]);
});

test("seeing and hearing are chosen separately for each hand", () => {
  const choices = { left: { show: false, sound: false }, right: { show: true, sound: true } };
  const { shown, ghost, heard } = applyChoices(moment, choices);
  assert.deepEqual(shown, ["right"]);
  assert.deepEqual(ghost.struck, [36]);
  assert.deepEqual(mids(heard), [60, 64]);
  assert.deepEqual(applyChoices({ right: moment.right }, choices).shown, ["right"], "a hand that is not playing is simply absent");
});

test("stored choices are read back, and nonsense is ignored", () => {
  assert.deepEqual(readChoices('{"left":{"show":false},"right":{"sound":false,"show":"yes"}}'), {
    left: { show: false, sound: true },
    right: { show: true, sound: false },
  });
  assert.deepEqual(readChoices("not json"), defaultChoices());
  assert.deepEqual(readChoices(null), defaultChoices());
});
