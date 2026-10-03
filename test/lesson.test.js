import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assignFingering } from "../fingering.js";
import { briefText, cleanLesson, defaultLesson, handMoments, lessonRange, momentName, shownText, slowTempo, spokenNote, stageHands } from "../lesson.js";
import { parseScore } from "../score-model.js";
import { cleanStyle, findStyle, STYLES } from "../teaching-styles.js";

async function minorDescent(overrides = {}) {
  const score = parseScore(await readFile(new URL("../scores/minor-descent.musicxml", import.meta.url), "utf8"));
  const fingered = assignFingering(score.events, { overrides });
  return { score, positions: fingered.positions, events: fingered.events, tempo: score.tempo ?? 80 };
}

test("a lesson starts at the measure shown and takes a few after it", () => {
  assert.deepEqual(defaultLesson(2, 16), { from: 2, to: 5 });
  assert.deepEqual(defaultLesson(14, 16), { from: 14, to: 15 }, "but not past the end of the piece");
  assert.deepEqual(cleanLesson({ from: 1, to: 3, style: "one-thing", score: "abc", part: 2 }), { part: 2, mode: "teacher", from: 1, to: 3, style: "one-thing", score: "abc" });
  assert.equal(cleanLesson({ from: 1, to: 3, style: "shouting" }).style, "lead", "an unknown way of teaching is the default");
  assert.equal(cleanLesson({ from: 3, to: 1 }), null);
  assert.equal(cleanLesson("later"), null);
});

test("the ways of teaching each have a name, a blurb and instructions", () => {
  assert.deepEqual(STYLES.map((style) => style.id), ["lead", "hands-separate", "one-thing", "play-along"]);
  for (const style of STYLES) {
    assert.ok(style.name && style.blurb && style.instructions.length > 100, style.id);
  }
  assert.equal(cleanStyle("hands-separate"), "hands-separate");
  assert.equal(cleanStyle(undefined), "lead");
  assert.match(findStyle("hands-separate").instructions, /Right hand alone/);
});

test("each stage shows and sounds its own hands", () => {
  assert.deepEqual(stageHands("right"), { left: { show: false, sound: false }, right: { show: true, sound: true } });
  assert.deepEqual(stageHands("left"), { left: { show: true, sound: true }, right: { show: false, sound: false } });
  assert.deepEqual(stageHands("both"), { left: { show: true, sound: true }, right: { show: true, sound: true } });
  assert.equal(slowTempo(72), 36);
  assert.equal(slowTempo(40), 30, "never below the slowest the transport plays");
});

test("notes are spoken the way a teacher says them, and the voice's directions are not shown", () => {
  assert.equal(spokenNote("C4"), "C", "no octave: the hand on the screen shows which");
  assert.equal(spokenNote("F#4"), "F sharp");
  assert.equal(spokenNote("Bb3"), "B flat");
  assert.equal(shownText("[warmly] Thumb on A. [short pause] Now the next one."), "Thumb on A. Now the next one.");
});

test("the passage is found in the score", async () => {
  const { score } = await minorDescent();
  const range = lessonRange({ from: 1, to: 2 }, score.measures);
  assert.equal(range.start, score.measures[1].start);
  assert.equal(range.end, score.measures[3].start);
  assert.equal(range.from, score.measures[1].number);
  // A passage can be kept to part of its measures.
  const part = lessonRange({ from: 1, to: 2, end: score.measures[1].start + 2 }, score.measures);
  assert.deepEqual([part.start, part.end], [score.measures[1].start, score.measures[1].start + 2]);
  assert.equal(lessonRange({ from: 1, to: 2, end: 9999 }, score.measures).end, score.measures[3].start, "an end outside the measures is not kept");
});

test("the brief tells the teacher where each hand sits and every moment it plays, by name", async () => {
  const music = await minorDescent();
  const range = lessonRange({ from: 0, to: 1 }, music.score.measures);
  const brief = briefText(music, range);
  assert.match(brief, /^Measures 1 to 2 of "Minor Descent"\./);
  assert.match(brief, /RIGHT HAND\nSits at the start with: (thumb|pointer|middle|ring|pinky) on [A-G][#b]?\d/);
  assert.match(brief, /\(fingering (from the score|the app's own choice)\)/);
  assert.match(brief, /LEFT HAND\n[^\n]*\nMoves at 2:1 to: thumb on A2, middle on C3, pinky on F3\.\nPlays/, "a move is told once, where the fingers change");
  assert.match(brief, /LEFT HAND\n/);
  const right = handMoments(music.events, "right", range);
  assert.ok(right.length > 1);
  for (const event of right) assert.ok(brief.includes(`  ${momentName(event)}`), `moment ${momentName(event)} is listed`);
  assert.match(brief, new RegExp(`Plays, in order \\(${right.length} moments`));
  const struck = right[0].notes[0];
  assert.ok(brief.includes(`${["thumb", "pointer", "middle", "ring", "pinky"][struck.finger - 1]} on ${struck.note}`), "finger first, then the note with its octave");
  // A correction is told as such.
  const corrected = await minorDescent({ [momentName(right[0])]: { right: { [struck.note]: 5 } } });
  assert.match(briefText(corrected, range), /pinky on/);
  assert.match(briefText(corrected, range), /corrected by the learner/);
  // A hand that does not play says so.
  const silent = { ...music, events: music.events.filter((event) => event.hand === "right") };
  assert.match(briefText(silent, range), /LEFT HAND\nDoes not play in these measures\./);
  assert.equal(momentName({ measure: "3", beat: 2.5 }), "3:2.5");
  assert.equal(momentName({ measure: "3", beat: 1.3333333333 }), "3:1.333");
});
