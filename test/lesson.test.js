import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assignFingering } from "../fingering.js";
import { advanceLesson, cleanLesson, defaultLesson, describeAdvance, describeNext, describeProgress, FINGER_PAUSE, introTempo, lessonParts, lessonPassage, lessonRange, lessonSteps, readyMadeSteps, slowTempo, spokenNote, stageHands } from "../lesson.js";
import { parseScore } from "../score-model.js";

async function minorDescent(target = 72) {
  const score = parseScore(await readFile(new URL("../scores/minor-descent.musicxml", import.meta.url), "utf8"));
  const fingered = assignFingering(score.events);
  return { score, positions: fingered.positions, events: fingered.events, target };
}
// The ready-made lesson, all its parts end to end.
const readyMadePlan = (lesson, music) => ({ steps: lessonParts(lesson, music).flatMap((part) => readyMadeSteps(part, lesson, music)) });
const said = (step) => step.lines.filter((line) => typeof line !== "number").map((line) => line.say ?? line);

test("a lesson starts at the measure shown and takes a few after it", () => {
  assert.deepEqual(defaultLesson(2, 16), { from: 2, to: 5, part: 0, step: 0 });
  assert.deepEqual(defaultLesson(14, 16), { from: 14, to: 15, part: 0, step: 0 }, "but not past the end of the piece");
  assert.deepEqual(cleanLesson({ from: 1, to: 3, part: 2, step: 4, score: "abc", stage: "left" }), { from: 1, to: 3, part: 2, step: 4, score: "abc" });
  assert.equal(cleanLesson({ from: 1, to: 3, step: "soon" }).step, 0, "an unknown place in the plan starts it over");
  assert.equal(cleanLesson({ from: 3, to: 1 }), null);
  assert.equal(cleanLesson("later"), null);
});

test("the ready-made lesson: the passage heard, then each hand placed, shown, played along and looped, then both", async () => {
  const music = await minorDescent();
  assert.deepEqual(lessonParts({ from: 0, to: 3 }, music), ["intro", "right", "left", "both"]);
  const plan = readyMadePlan({ from: 0, to: 3 }, music);
  assert.deepEqual(plan.steps.map((step) => step.label), [
    "The whole passage",
    "Right hand · placing the hand", "Right hand · the notes", "Right hand · your turn", "Right hand · looping",
    "Left hand · placing the hand", "Left hand · the notes", "Left hand · your turn", "Left hand · looping",
    "Both hands · placing the hands", "Both hands · the notes", "Both hands · your turn", "Both hands · looping",
  ]);
  const [intro, place, show, once, loop] = plan.steps;
  assert.deepEqual([intro.hands, intro.times, intro.tempo, intro.auto], ["both", 1, introTempo(72), true], "heard once, both hands, nearly full, and on by itself");
  assert.deepEqual([place.hands, place.times, place.auto, place.button], ["right", 0, false, "Hand is set"], "placing plays nothing and waits");
  assert.deepEqual([show.times, show.tempo, show.climb], [2, slowTempo(72), false], "shown twice, slowly");
  assert.match(show.after, /ready to try it/);
  assert.deepEqual([once.times, once.climb], [1, false]);
  assert.deepEqual([loop.times, loop.climb, loop.tempo], [Infinity, true, 36], "then looped, climbing from the slow tempo");
  assert.match(describeAdvance("done", { target: 72 }), /Well done/);
});

test("a hand that does not play has no part in the ready-made lesson", async () => {
  const music = await minorDescent();
  const leftOnly = { ...music, events: music.events.filter((event) => event.hand === "left") };
  assert.deepEqual(lessonParts({ from: 0, to: 3 }, leftOnly), ["intro", "left"]);
  const single = { ...music, events: music.events.filter((event) => event.hand === "right").slice(0, 1) };
  assert.deepEqual(lessonParts({ from: 0, to: 0 }, single), ["right"], "a note or two is not heard whole first");
  assert.deepEqual(lessonParts({ from: 0, to: 0 }, { ...music, events: [] }), [], "nothing to learn where nothing is played");
  const plan = readyMadePlan({ from: 0, to: 3 }, leftOnly);
  assert.deepEqual([...new Set(plan.steps.map((step) => step.hands))], ["both", "left"], "the introduction, and the left hand");
  assert.equal(plan.steps.length, 5, "no right hand, and so no both hands");
  assert.equal(said(plan.steps[1])[0], "Now let's break it down. Left hand first.", "the first hand is said to be first");
});

test("got it: on through the steps and the parts, climbing three beats a minute where a step climbs", async () => {
  const music = await minorDescent(100);
  const names = lessonParts({ from: 0, to: 3 }, music);
  const parts = names.map((part) => readyMadeSteps(part, { from: 0, to: 3 }, music));
  let lesson = { from: 0, to: 3, part: 0, step: 0 };
  let tempo = parts[0][0].tempo;
  const events = [];
  for (let presses = 0; presses < 200 && lesson; presses += 1) {
    const next = advanceLesson(lesson, parts[lesson.part], parts.length, tempo, 100);
    events.push(`${lesson.part}.${lesson.step}:${next.event}`);
    if (next.event === "step") tempo = parts[next.lesson.part][next.lesson.step].tempo; // each step is entered at its own tempo
    else if (next.tempo) tempo = next.tempo;
    lesson = next.lesson;
  }
  assert.deepEqual(events.slice(0, 6), ["0.0:step", "1.0:step", "1.1:step", "1.2:step", "1.3:faster", "1.3:faster"], "the opening, then the right hand step by step, then faster at each press in the loop");
  assert.equal(events[20], "1.3:target", "the climb stops at the score's tempo");
  assert.equal(events[21], "1.3:step", "then the next part");
  assert.equal(events[22], "2.0:step");
  assert.equal(events.at(-1), "3.3:done");
  assert.equal(lesson, null);
  const loop = parts[1];
  assert.equal(advanceLesson({ from: 0, to: 3, part: 1, step: 3 }, loop, 4, 130, 100).event, "step", "a tempo already past the score's still moves on");
  assert.equal(advanceLesson({ from: 0, to: 3, part: 1, step: 3 }, loop, 4, 98, 100).tempo, 100, "the last step up lands exactly on the tempo");
  // A loop that does not climb is left with one press.
  assert.equal(advanceLesson({ from: 0, to: 0, part: 0, step: 0 }, [{ times: Infinity, climb: false, tempo: 50 }], 1, 50, 100).event, "done");
});

test("each step shows and sounds its own hands, and says what Play keeps to", () => {
  assert.deepEqual(stageHands("right"), { left: { show: false, sound: false }, right: { show: true, sound: true } });
  assert.deepEqual(stageHands("left"), { left: { show: true, sound: true }, right: { show: false, sound: false } });
  assert.deepEqual(stageHands("both"), { left: { show: true, sound: true }, right: { show: true, sound: true } });
  const lesson = { from: 2, to: 5, step: 0 };
  assert.deepEqual(lessonPassage(lesson, { times: 0 }), { from: 2, to: 5, times: 1, start: null, end: null }, "nothing plays by itself, but Play still keeps to the passage");
  assert.deepEqual(lessonPassage(lesson, { times: 2, end: 9.5 }), { from: 2, to: 5, times: 2, start: null, end: 9.5 }, "as far into the passage as the step goes");
  assert.deepEqual(lessonPassage(lesson, { times: Infinity }), { from: 2, to: 5, times: null, start: null, end: null }, "over and over");
});

test("notes are spoken the way a teacher says them", () => {
  assert.equal(spokenNote("C4"), "C", "no octave: the hand on the screen shows which");
  assert.equal(spokenNote("F#4"), "F sharp");
  assert.equal(spokenNote("Bb3"), "B flat");
});

test("the passage is found in the score and among its steps", async () => {
  const { score } = await minorDescent();
  const range = lessonRange({ from: 1, to: 2 }, score.measures);
  assert.equal(range.start, score.measures[1].start);
  assert.equal(range.end, score.measures[3].start);
  assert.equal(range.from, score.measures[1].number);
  const steps = [...new Set(score.events.filter((event) => event.attack).map((event) => event.time))].sort((a, b) => a - b).map((time) => ({ time }));
  const found = lessonSteps(range, steps);
  assert.ok(steps[found.first].time >= range.start);
  assert.ok(steps[found.last].time < range.end);
  assert.ok(found.last + 1 >= steps.length || steps[found.last + 1].time >= range.end);
  assert.equal(lessonSteps({ start: 10000, end: 10004 }, steps), null, "a passage past the music has no steps");
  // A passage can be kept to part of its measures.
  const part = lessonRange({ from: 1, to: 2, end: score.measures[1].start + 2 }, score.measures);
  assert.deepEqual([part.start, part.end], [score.measures[1].start, score.measures[1].start + 2]);
  assert.equal(lessonRange({ from: 1, to: 2, end: 9999 }, score.measures).end, score.measures[3].start, "an end outside the measures is not kept");
});

test("the ready-made words: fingers by name and before the note, each note once, nothing long-winded", async () => {
  const music = await minorDescent();
  const plan = readyMadePlan({ from: 0, to: 3 }, music);
  const [intro, place, show, once, loop, , leftShow] = [plan.steps[0], plan.steps[1], plan.steps[2], plan.steps[3], plan.steps[4], plan.steps[5], plan.steps[6]];
  assert.deepEqual(said(intro), ["We're going to learn measures 1 to 4 of Minor Descent.", "Here it is at nearly full speed."]);

  // Placing: a finger a line, each putting the hand on the stage where it has got to.
  assert.equal(place.lines[0], "Now let's break it down. Right hand first.");
  const placed = place.lines.filter((line) => line?.say && /^(Thumb|Pointer finger|Middle finger|Ring finger|Pinky) on [A-G]( sharp| flat)?\.$/.test(line.say));
  assert.ok(placed.length >= 2, "each finger gets its own line");
  assert.equal(place.lines[place.lines.indexOf(placed[0]) + 1], FINGER_PAUSE, "and a pause after it");
  assert.equal(placed[0].pose.right.fingers.length, 1);
  assert.equal(placed[1].pose.right.fingers.length, 2);
  assert.deepEqual(placed[1].pose.right.press, [placed[1].pose.right.fingers.at(-1).note]);
  const rest = place.lines.find((line) => line?.pose && !line.pose.right.press.length);
  assert.equal(rest.pose.right.fingers.length, placed.length, "then the whole hand rests on its keys");
  assert.match(place.lines.at(-1), /Press Got it when your hand is set\./);

  // Showing: how many and which fingers; each different note once, played as it is named; then the run.
  assert.match(show.lines[0], /^Going to hit 5 notes and chords: pinky; ring finger; pinky and middle together; /);
  const named = show.lines.filter((line) => line?.time !== undefined);
  assert.equal(named.length, 4, "a note the hand has already been shown is not explained again");
  assert.match(named[0].say, /^(Thumb|Pointer finger|Middle finger|Ring finger|Pinky) on [A-G]( sharp| flat)?\.$/, "the finger, then the note");
  assert.equal(show.lines.at(-3), "A, G, A F, A E, A with pinky, ring, middle and pointer.", "then the whole run, notes and then fingers");
  assert.equal(show.lines.at(-1), "Now watch. I'll play it twice.");
  assert.equal(leftShow.lines[0], "Going to hit 7 chords: thumb, middle and pinky together, 4 times; thumb and middle together, 3 times.", "the same fingers running are told once");
  assert.ok(said(leftShow).includes("Thumb, middle and pinky on A, C and E."), "a chord is named whole, its fingers first");
  assert.deepEqual(said(plan.steps[10]), ["Watch both hands together. I'll play it twice."], "both hands at once are shown, not named");

  assert.deepEqual(said(once), ["Now your turn. Once through, slowly, at 36. Play along."]);
  assert.match(said(loop)[0], /^Good\. Now it loops\. Try 36; .*3 beats a minute at a time, to 72\./);
  for (const step of plan.steps) {
    for (const line of said(step)) {
      assert.ok(line.length < 130, line);
      assert.doesNotMatch(line, /finger \d|\d on /i, "fingers are never called by number");
    }
  }
  assert.equal(describeAdvance("faster", { tempo: 66, target: 72 }), "Now try 66.");
  assert.match(describeAdvance("target", { tempo: 72, target: 72 }), /Now try full tempo, 72/);
});

test("the panel says where the lesson is and what got it will do", () => {
  const tempos = { tempo: 39, target: 72 };
  assert.equal(describeProgress({ label: "Left hand · placing the hand", times: 0 }, tempos), "Left hand · placing the hand");
  assert.equal(describeProgress({ label: "Left hand · your turn", times: 1 }, tempos), "Left hand · your turn · at 39");
  assert.equal(describeProgress({ label: "Left hand · looping", times: Infinity, climb: true }, tempos), "Left hand · looping · 39 of 72");
  assert.equal(describeProgress({ label: "Left hand · looping", times: Infinity, climb: true }, { tempo: 72, target: 72 }), "Left hand · looping · at full tempo, 72");
  assert.equal(describeNext({ button: "Hand is set" }, tempos), "✓ Hand is set");
  assert.equal(describeNext({ button: "" }, tempos), "✓ Got it");
  assert.equal(describeNext({ auto: true, button: "" }, tempos), "Skip");
  assert.equal(describeNext({ climb: true, button: "Got it" }, tempos), "✓ Got it · faster");
  assert.equal(describeNext({ climb: true, button: "Got it" }, { tempo: 72, target: 72 }), "✓ Got it");
});
