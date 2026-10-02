import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assignFingering } from "../fingering.js";
import { FINGER_PAUSE, NOTE_PAUSE } from "../lesson.js";
import { lessonBrief, planFromScript, shownText, writerRequest } from "../lesson-writer.js";
import { parseScore } from "../score-model.js";

async function minorDescent() {
  const score = parseScore(await readFile(new URL("../scores/minor-descent.musicxml", import.meta.url), "utf8"));
  const fingered = assignFingering(score.events);
  const lesson = { from: 0, to: 3, step: 0 };
  return { lesson, brief: lessonBrief(lesson, { score, positions: fingered.positions, events: fingered.events, target: 72 }), fingered };
}

test("the writer is told what the passage holds, and what the hands on the screen can do", async () => {
  const { brief } = await minorDescent();
  assert.equal(brief.title, "Minor Descent");
  assert.equal(brief.measures, "measures 1 to 4");
  assert.deepEqual(brief.tempo, { score: 72, intro: 65, slow: 36, step: 3 });
  assert.deepEqual(brief.hands.left.fingers.map((entry) => entry.finger), [1, 3, 5]);
  assert.equal(brief.hands.left.moments.length, 7);
  assert.equal(brief.hands.right.moves, true);
  assert.deepEqual(Object.keys(brief.actions).filter((name) => name.startsWith("left:")), ["left:place:thumb", "left:place:middle", "left:place:pinky", "left:place:hand", "left:play:1", "left:play:2", "left:play:3", "left:play:4", "left:play:5", "left:play:6", "left:play:7"]);
});

test("the writer is asked to design one part at a time, with the rules it has settled on", async () => {
  const { brief } = await minorDescent();
  const right = writerRequest(brief, "right", { before: "intro" });
  assert.deepEqual(right.schema.required, ["steps", "closing"]);
  assert.match(right.prompt, /^Write the RIGHT HAND's part/);
  assert.match(right.prompt, /ring finger on G {2}→ {2}action "right:place:ring"/);
  assert.match(right.prompt, /pinky on A \+ middle finger on F {2}→ {2}action "right:play:3"/);
  assert.doesNotMatch(right.prompt, /left:play/, "a hand's part is told only of that hand");
  assert.match(right.prompt, /The left hand also plays/);
  assert.match(right.prompt, /heard the whole passage played once/);
  assert.match(right.prompt, /leave "closing" empty/);
  assert.doesNotMatch(right.prompt, /[A-G]\d/, "no octave numbers reach the writer");
  const both = writerRequest(brief, "both", { before: "left", last: true });
  assert.match(both.prompt, /^Write the BOTH HANDS part/);
  assert.match(both.prompt, /"right:play:1"/);
  assert.match(both.prompt, /"left:play:7"/);
  assert.match(both.prompt, /finished learning the left hand/);
  assert.match(both.prompt, /LAST of the lesson/);
  assert.match(writerRequest(brief, "left").prompt, /Your part opens the lesson/);
  const octave = structuredClone(brief);
  octave.hands.left = { fingers: [{ finger: 1, note: "A2" }, { finger: 5, note: "A1" }], moves: false, moments: [{ time: 0, notes: [{ note: "A1", finger: 5 }, { note: "A2", finger: 1 }] }] };
  octave.hands.right = { fingers: [], moves: false, moments: [] };
  const told = writerRequest(octave, "left").prompt;
  assert.match(told, /thumb on the higher A {2}→/, "two keys of the same name under one hand are told apart");
  assert.match(told, /pinky on the lower A \+ thumb on the higher A/);
  assert.match(told, /only hand that plays/);
  for (const rule of [/thumb, pointer finger, middle finger, ring finger, pinky/, /finger first, then the note/, /Never an octave number/, /square brackets/, /ONE THING AT A TIME/, /Let's get THIS note/, /Never hand the learner a whole measure at once/, /has nothing to build and no tempo to work up/]) assert.match(right.system, rule);
});

test("what the writer designed becomes a plan the lesson can run", async () => {
  const { brief } = await minorDescent();
  const step = (over) => ({ label: "Left hand · placing the hand", hands: "left", lines: [], play: "nothing", until: "", tempo: "slow", climb: false, next: "got it", button: "Hand is set", after: "", ...over });
  const plan = planFromScript(
    {
      steps: [
        step({
          lines: [
            { say: "[warmly] Now the left hand.", do: "" },
            { say: "Thumb on A.", do: "left:place:thumb" },
            { say: "Pinky on E.", do: "left:place:pinky" },
            { say: "Let it rest.", do: "left:place:hand" },
            { say: "Press Got it when you're set.", do: "left:dance" },
            { say: "  ", do: "" },
          ],
        }),
        step({ label: "Left hand · the chord", lines: [{ say: "Thumb, middle and pinky on A, C and E.", do: "left:play:1" }], play: "twice", tempo: "nearly full", button: "My turn", after: "Press Got it when you're ready." }),
        step({ label: "", lines: [{ say: "Loop it.", do: "" }], play: "loop", tempo: "full", climb: true, next: "by itself" }),
        step({ lines: [], play: "nothing" }),
        step({ hands: "both", lines: [{ say: "Right hand: ring finger on G, pinky on A.", do: "right:place:hand" }], play: "once", next: "by itself", climb: true }),
      ],
      closing: "[warmly] That's it.",
    },
    brief,
  );
  assert.equal(plan.steps.length, 4, "a step that says nothing and plays nothing is left out");
  const [place, show, loop, together] = plan.steps;
  assert.equal(place.lines[0], "[warmly] Now the left hand.");
  assert.deepEqual(place.lines[1].pose.left, { fingers: [{ finger: 1, note: "A2" }], press: ["A2"] }, "the finger named goes down and presses its key");
  assert.equal(place.lines[2], FINGER_PAUSE, "with time to do it");
  assert.deepEqual(place.lines[3].pose.left.fingers.map((entry) => entry.finger), [1, 5], "the hand builds up as the fingers are named");
  assert.deepEqual(place.lines[5].pose.left, { fingers: brief.hands.left.fingers, press: [] }, "the whole hand at rest");
  assert.equal(place.lines[6], "Press Got it when you're set.", "an action that does not exist is just not done");
  assert.equal(place.lines.length, 7, "an empty line is left out");
  assert.deepEqual([place.times, place.tempo, place.auto, place.button], [0, 36, false, "Hand is set"]);

  assert.deepEqual(show.lines, [{ say: "Thumb, middle and pinky on A, C and E.", time: brief.hands.left.moments[0].time }, NOTE_PAUSE]);
  assert.deepEqual([show.times, show.tempo, show.after, show.end], [2, 65, "Press Got it when you're ready.", null], "the whole passage, unless it says how far");
  assert.deepEqual([loop.label, loop.times, loop.tempo, loop.climb, loop.auto], ["Left hand", Infinity, 72, true, false], "a loop never moves on by itself");
  assert.deepEqual([together.times, together.climb, together.auto], [1, false, true], "and only a loop climbs");
  assert.ok(together.lines[0].pose.right.press.length >= 1, "with both hands, the outer fingers press to show where the hand sits");
  assert.equal(plan.closing, "[warmly] That's it.");

  // Playing up to a moment stops where the next thing those hands play begins.
  const moments = brief.hands.left.moments.map((moment) => moment.time);
  const built = planFromScript({ steps: [step({ lines: [{ say: "Thumb on A.", do: "left:play:1" }], play: "once", until: "left:play:1" }), step({ lines: [{ say: "And the last.", do: "" }], play: "once", until: "left:play:7" }), step({ hands: "both", lines: [{ say: "Together.", do: "" }], play: "once", until: "left:play:1" }), step({ lines: [{ say: "All of it.", do: "" }], play: "once", until: "left:play:99" })], closing: "" }, brief);
  assert.equal(built.steps[0].end, moments[1], "up to the first moment: until the second begins");
  assert.equal(built.steps[1].end, null, "up to the last moment is the whole passage");
  assert.equal(built.steps[2].end, Math.min(...[...moments, ...brief.hands.right.moments.map((moment) => moment.time)].filter((time) => time > moments[0])), "with both hands, whichever plays next");
  assert.equal(built.steps[3].end, null, "a moment that does not exist is the whole passage");

  assert.equal(planFromScript({ steps: [] }, brief), null, "nothing written: the ready-made lesson steps in");
  assert.equal(planFromScript(null, brief), null);
  assert.equal(planFromScript({ steps: Array.from({ length: 60 }, () => step({ lines: [{ say: "Again.", do: "" }] })) }, brief).steps.length, 40, "a lesson is not endless");
});

test("the voice's directions are not shown in the words on the screen", () => {
  assert.equal(shownText("[warmly] Thumb on A. [short pause] Now... the pinky."), "Thumb on A. Now... the pinky.");
  assert.equal(shownText("Press Got it [encouraging] ."), "Press Got it.");
  assert.equal(shownText("Pinky on E."), "Pinky on E.");
});
