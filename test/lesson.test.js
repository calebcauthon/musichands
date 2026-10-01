import assert from "node:assert/strict";
import test from "node:test";
import { assignFingering } from "../fingering.js";
import { advanceLesson, cleanLesson, defaultLesson, describeAdvance, describeNext, describePlayed, describeProgress, FINGER_PAUSE, introTempo, lessonHands, lessonPassage, lessonRange, lessonSteps, phaseLines, phasePlays, slowTempo, spokenNote, stageHands } from "../lesson.js";
import { parseScore } from "../score-model.js";
import { readFile } from "node:fs/promises";

test("a lesson starts at the measure shown and takes a few after it", () => {
  assert.deepEqual(defaultLesson(2, 16), { from: 2, to: 5, stage: "right", phase: "intro" });
  assert.deepEqual(defaultLesson(14, 16), { from: 14, to: 15, stage: "right", phase: "intro" }, "but not past the end of the piece");
  assert.deepEqual(cleanLesson({ from: 1, to: 3, stage: "left", phase: "ramp" }), { from: 1, to: 3, stage: "left", phase: "ramp" });
  assert.equal(cleanLesson({ from: 1, to: 3, phase: "slow" }).phase, "intro", "an unknown phase starts the lesson over");
  assert.equal(cleanLesson({ from: 3, to: 1 }), null);
  assert.equal(cleanLesson("later"), null);
});

test("got it: place the hand, once through, then loop three beats a minute faster at a go, then the next hand, then done", () => {
  const target = 100;
  assert.equal(slowTempo(target), 50);
  let tempo = introTempo(target);
  assert.equal(tempo, 90, "the whole passage is first heard at nearly full speed");
  let lesson = defaultLesson(0, 8);
  assert.deepEqual(lessonHands(lesson), stageHands("both"), "with both hands");
  const broken = advanceLesson(lesson, tempo, target);
  assert.equal(broken.event, "breakdown");
  assert.deepEqual(broken.lesson, { from: 0, to: 3, stage: "right", phase: "position" }, "then it is broken down, right hand first, slowly");
  assert.deepEqual(lessonHands(broken.lesson), stageHands("right"));
  lesson = broken.lesson;
  tempo = broken.tempo;
  const events = [];
  for (let presses = 0; presses < 200 && lesson; presses += 1) {
    const next = advanceLesson(lesson, tempo, target);
    events.push(`${lesson.stage}:${lesson.phase}:${next.event}:${next.tempo}`);
    lesson = next.lesson;
    tempo = next.tempo;
  }
  assert.equal(events[0], "right:position:show:50", "the hand is placed; then the notes are shown");
  assert.equal(events[1], "right:show:once:50", "then once through, slowly");
  assert.equal(events[2], "right:once:ramp:50", "then it loops, at the same tempo");
  assert.equal(events[3], "right:ramp:faster:53", "then faster at each press");
  assert.equal(events[19], "right:ramp:target:100", "the climb stops at the score's tempo");
  assert.equal(events[20], "right:ramp:stage:50", "then the next hand, placed afresh");
  assert.equal(events[21], "left:position:show:50");
  assert.equal(events[42], "both:position:show:50");
  assert.equal(events.at(-1), "both:ramp:done:100");
  assert.equal(events.length, 63);
  assert.equal(lesson, null);
  assert.equal(phasePlays("intro"), 1);
  assert.equal(phasePlays("position"), 0);
  assert.equal(phasePlays("show"), 2, "the passage is shown a couple of times");
  assert.equal(phasePlays("once"), 1);
  assert.equal(phasePlays("ramp"), Infinity);
});

test("a tempo the player has already pushed past the score's still moves on", () => {
  const next = advanceLesson({ from: 0, to: 1, stage: "right", phase: "ramp" }, 130, 100);
  assert.equal(next.event, "stage");
  assert.equal(next.lesson.stage, "left");
  assert.equal(advanceLesson({ from: 0, to: 1, stage: "right", phase: "ramp" }, 98, 100).tempo, 100, "the last step up lands exactly on the tempo");
});

test("each stage shows and sounds its own hands", () => {
  assert.deepEqual(stageHands("right"), { left: { show: false, sound: false }, right: { show: true, sound: true } });
  assert.deepEqual(stageHands("left"), { left: { show: true, sound: true }, right: { show: false, sound: false } });
  assert.deepEqual(stageHands("both"), { left: { show: true, sound: true }, right: { show: true, sound: true } });
});

test("notes are spoken the way a teacher says them", () => {
  assert.equal(spokenNote("C4"), "C", "no octave: the hand on the screen shows which");
  assert.equal(spokenNote("F#4"), "F sharp");
  assert.equal(spokenNote("Bb3"), "B flat");
});

test("the passage is found in the score and among its steps", async () => {
  const score = parseScore(await readFile(new URL("../scores/minor-descent.musicxml", import.meta.url), "utf8"));
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
});

test("the voice places the hand a finger at a time, with time to get there", async () => {
  const xml = await readFile(new URL("../scores/minor-descent.musicxml", import.meta.url), "utf8");
  const score = parseScore(xml);
  const fingered = assignFingering(score.events);
  const context = { score, positions: fingered.positions, events: fingered.events, tempo: 36, target: 72 };
  const lesson = { from: 0, to: 3, stage: "right", phase: "position" };
  const lines = phaseLines(lesson, context);
  assert.deepEqual(phaseLines({ ...lesson, phase: "intro" }, context), ["We're going to learn measures 1 to 4 of Minor Descent.", "Here it is at nearly full speed."]);
  assert.equal(lines[0], "Now let's break it down. Right hand first.");
  const placed = lines.filter((line) => line?.say && /^(Thumb|Finger \d|Pinky) on [A-G]( sharp| flat)?\.$/.test(line.say));
  assert.ok(placed.length >= 2, "each finger gets its own line");
  assert.equal(lines[1], placed[0], "straight to the fingers");
  assert.equal(lines[lines.indexOf(placed[0]) + 1], FINGER_PAUSE, "and a pause after it");
  // Each line puts the hand on the stage where it has got to, pressing the key just named.
  assert.deepEqual(Object.keys(placed[0].pose), ["right"]);
  assert.equal(placed[0].pose.right.fingers.length, 1);
  assert.equal(placed[1].pose.right.fingers.length, 2);
  assert.deepEqual(placed[1].pose.right.press, [placed[1].pose.right.fingers.at(-1).note]);
  const rest = lines.find((line) => line?.pose && !line.pose.right.press.length);
  assert.equal(rest.pose.right.fingers.length, placed.length, "then the whole hand rests on its keys");
  assert.match(rest.say, /moves later on|That's the position/);
  assert.match(lines.at(-1), /Press Got it when your hand is set\./);
  assert.ok(lines.every((line) => typeof line === "number" || (line.say ?? line).length < 90), "nothing long-winded");

  const left = phaseLines({ ...lesson, stage: "left" }, context);
  assert.equal(left[0], "Now the left hand.");
  assert.match(left[1].say, /^(Thumb|Finger \d|Pinky) on /);
  assert.deepEqual(Object.keys(left[1].pose), ["left"]);
  const both = phaseLines({ ...lesson, stage: "both" }, context);
  assert.equal(both[0], "Now both hands together.");
  assert.match(both[1].say, /^Right hand: .+ on [A-G]/);
  assert.ok(both[1].pose.right.fingers.length >= 2, "the whole hand at once");
  assert.ok(both[1].pose.right.press.length >= 1, "pressing the outer fingers' keys");
  assert.match(both[3].say, /^Left hand: /);
  assert.match(both.at(-1), /both hands are set/);

  // Showing: each moment named with its finger and played as it is named, then the passage played to watch.
  const shown = phaseLines({ ...lesson, phase: "show" }, context);
  assert.equal(shown[0], "Here are the notes.");
  const named = shown.filter((line) => line?.time !== undefined);
  const struck = fingered.events.filter((event) => event.hand === "right" && event.attack && event.time < score.measures[3].start + score.measures[3].length);
  assert.deepEqual(named.map((line) => line.time), struck.map((event) => event.time), "one line for each moment the hand plays, in order");
  assert.match(named[0].say, /^[A-G]( sharp| flat)?, (thumb|finger \d|pinky)\.$|together, fingers /);
  assert.equal(shown.at(-1), "Now watch. I'll play it twice.");
  const leftShown = phaseLines({ ...lesson, stage: "left", phase: "show" }, context).filter((line) => line?.say).map((line) => line.say);
  assert.ok(leftShown.some((say) => /^[A-G].* and [A-G]( sharp| flat)? together, fingers \d.* and \d\.$/.test(say)), "a chord is named whole, with its fingers");
  assert.ok(leftShown.includes("Again."), "a chord played again is not spelt out again");
  assert.deepEqual(phaseLines({ ...lesson, stage: "both", phase: "show" }, context), ["Watch both hands together. I'll play it twice."]);
  assert.match(describePlayed("show"), /ready to try it/);
  assert.match(describePlayed("once"), /go again/);
  assert.equal(describePlayed("ramp"), "");

  assert.deepEqual(phaseLines({ ...lesson, phase: "once" }, context), ["Now your turn. Once through, slowly, at 36. Play along."]);
  assert.match(phaseLines({ ...lesson, phase: "ramp" }, context)[0], /^Good\. Now it loops\. Try 36; .*3 beats a minute at a time, to 72\./);
  assert.equal(describeAdvance("faster", { tempo: 66, target: 72 }), "Now try 66.");
  assert.match(describeAdvance("target", { tempo: 72, target: 72 }), /Now try full tempo, 72/);
  assert.match(describeAdvance("done", {}), /Well done/);
});

test("the panel says where the lesson is and what got it will do", () => {
  const lesson = { from: 0, to: 3, stage: "right", phase: "position" };
  assert.equal(describeProgress({ ...lesson, phase: "intro" }, { tempo: 65, target: 72 }), "The whole passage · at 65");
  assert.equal(describeNext({ ...lesson, phase: "intro" }, { tempo: 65, target: 72 }), "Skip · break it down");
  assert.equal(describeProgress(lesson, { tempo: 36, target: 72 }), "Right hand · placing the hand");
  assert.equal(describeNext(lesson, { tempo: 36, target: 72 }), "✓ Hand is set");
  assert.equal(describeProgress({ ...lesson, phase: "show" }, { tempo: 36, target: 72 }), "Right hand · the notes");
  assert.equal(describeNext({ ...lesson, phase: "show" }, { tempo: 36, target: 72 }), "✓ Got it · my turn");
  assert.equal(describeProgress({ ...lesson, phase: "once" }, { tempo: 36, target: 72 }), "Right hand · your turn, once through at 36");
  assert.equal(describeNext({ ...lesson, phase: "once" }, { tempo: 36, target: 72 }), "✓ Got it · loop it");
  assert.equal(describeProgress({ ...lesson, phase: "ramp" }, { tempo: 39, target: 72 }), "Right hand · looping · 39 of 72");
  assert.equal(describeNext({ ...lesson, phase: "ramp" }, { tempo: 39, target: 72 }), "✓ Got it · faster");
  assert.equal(describeProgress({ ...lesson, phase: "ramp" }, { tempo: 72, target: 72 }), "Right hand · at full tempo, 72");
  assert.equal(describeNext({ ...lesson, phase: "ramp" }, { tempo: 72, target: 72 }), "✓ Got it · next hand");
  assert.equal(describeNext({ ...lesson, stage: "both", phase: "ramp" }, { tempo: 72, target: 72 }), "✓ Got it · finish");
});

test("each phase says what Play keeps to: the lesson's measures, as often as the phase plays them", () => {
  const lesson = { from: 2, to: 5, stage: "right", phase: "intro" };
  assert.deepEqual(lessonPassage(lesson), { from: 2, to: 5, times: 1 });
  assert.deepEqual(lessonPassage({ ...lesson, phase: "position" }), { from: 2, to: 5, times: 1 }, "nothing plays by itself, but Play still keeps to the passage");
  assert.deepEqual(lessonPassage({ ...lesson, phase: "show" }), { from: 2, to: 5, times: 2 });
  assert.deepEqual(lessonPassage({ ...lesson, phase: "once" }), { from: 2, to: 5, times: 1 });
  assert.deepEqual(lessonPassage({ ...lesson, phase: "ramp" }), { from: 2, to: 5, times: null }, "over and over");
  assert.equal(cleanLesson({ ...lesson, score: "abc" }).score, "abc", "a lesson remembers the piece it is on");
});
