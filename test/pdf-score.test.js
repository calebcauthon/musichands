import assert from "node:assert/strict";
import test from "node:test";
import { pdfToMusicXml, recognizeScore } from "../pdf-score.js";
import { parseScore } from "../score-model.js";

// Draws a page the way a notation program does: staff lines a measure at a
// time, glyphs from a music font, stems and barlines as plain lines.
const SPACE = 5;
const HEAD = SPACE * 1.3;
const CODES = {
  treble: 0xe050, bass: 0xe062, whole: 0xe0a2, half: 0xe0a3, black: 0xe0a4,
  sharp: 0xe262, flat: 0xe260, natural: 0xe261, dot: 0xe1e7,
  wholeRest: 0xe4e3, halfRest: 0xe4e4, quarterRest: 0xe4e5, eighthRest: 0xe4e6,
  flagUp: 0xe240, flagDown: 0xe241, three: 0xe883,
};

class Page {
  constructor() {
    this.glyphs = [];
    this.lines = [];
    this.shapes = [{ curved: false, filled: true, points: [[0, 0], [600, 0], [600, 800], [0, 800], [0, 0]], left: 0, right: 600, top: 0, bottom: 800 }];
    this.systems = [];
  }

  glyph(code, x, y, size = SPACE * 4, font = "Leland") {
    this.glyphs.push({ text: String.fromCodePoint(code), code, x, y, size, width: code === CODES.black || code === CODES.half ? HEAD : SPACE, font });
  }

  text(string, x, y, size, font = "Edwin-Roman") {
    [...string].forEach((character, index) => {
      if (character !== " ") this.glyphs.push({ text: character, code: character.codePointAt(0), x: x + index * size * 0.5, y, size, width: size * 0.5, font });
    });
  }

  // A system of staves with barlines at the given x positions.
  system(top, clefs, barlines, { left = 50, right = 550, gap = SPACE * 7 } = {}) {
    const staves = clefs.map((clef, index) => ({ top: top + index * (SPACE * 4 + gap), clef }));
    for (const staff of staves) {
      const edges = [left, ...barlines.filter((x) => x < right), right];
      for (let line = 0; line < 5; line += 1) {
        for (let index = 1; index < edges.length; index += 1) {
          this.lines.push({ x1: edges[index - 1], y1: staff.top + line * SPACE, x2: edges[index], y2: staff.top + line * SPACE, width: 0.3 });
        }
      }
      // Clefs sit on the line they name.
      this.glyph(CODES[staff.clef], left + SPACE, staff.top + (staff.clef === "treble" ? 3 : 1) * SPACE);
    }
    // Upright lines are drawn a staff at a time, as real files do.
    for (const x of [left, ...barlines, right]) {
      staves.forEach((staff, index) => {
        const next = staves[index + 1];
        this.lines.push({ x1: x, y1: staff.top, x2: x, y2: next ? next.top : staff.top + SPACE * 4, width: 0.75 });
      });
    }
    const system = { staves, left, right };
    this.systems.push(system);
    return system;
  }

  y(system, staff, step) {
    return system.staves[staff].top + (step * SPACE) / 2;
  }

  // steps count half spaces down from the top line of the staff.
  note(system, staff, x, steps, { head = "black", stem = "up", length = 3.5, dots = 0, flag = false, accidental = null } = {}) {
    const list = [steps].flat();
    const ys = list.map((step) => this.y(system, staff, step));
    for (const [index, y] of ys.entries()) {
      this.glyph(CODES[head], x, y);
      for (let dot = 0; dot < dots; dot += 1) this.glyph(CODES.dot, x + SPACE * 1.8 + dot * SPACE * 0.8, list[index] % 2 === 0 ? y - SPACE / 2 : y);
    }
    if (accidental) this.glyph(CODES[accidental], x - SPACE * 1.25, ys[0]);
    if (head === "whole" || !stem) return null;
    const up = stem === "up";
    const stemX = up ? x + SPACE * 1.25 : x + SPACE * 0.05;
    const tip = up ? Math.min(...ys) - SPACE * length : Math.max(...ys) + SPACE * length;
    this.lines.push({ x1: stemX, y1: up ? Math.max(...ys) : Math.min(...ys), x2: stemX, y2: tip, width: 0.45 });
    if (flag) this.glyph(up ? CODES.flagUp : CODES.flagDown, stemX, tip);
    return { x: stemX, tip };
  }

  rest(system, staff, x, kind = "quarterRest", dots = 0) {
    const y = this.y(system, staff, 4);
    this.glyph(CODES[kind], x, y);
    for (let dot = 0; dot < dots; dot += 1) this.glyph(CODES.dot, x + SPACE * 1.6, y - SPACE / 2);
  }

  beam(from, to, thickness = SPACE * 0.5) {
    const points = [[from.x, from.tip], [to.x, to.tip], [to.x, to.tip + thickness], [from.x, from.tip + thickness], [from.x, from.tip]];
    this.shapes.push({ curved: false, filled: true, points, left: from.x, right: to.x, top: Math.min(from.tip, to.tip), bottom: Math.max(from.tip, to.tip) + thickness });
  }

  tie(system, staff, fromX, toX, step) {
    const y = this.y(system, staff, step) + SPACE * 0.4;
    const points = [[fromX, y], [fromX + 4, y + 4], [toX - 4, y + 4], [toX, y], [toX - 4, y + 3], [fromX + 4, y + 3], [fromX, y], [fromX, y]];
    this.shapes.push({ curved: true, filled: true, points, left: fromX, right: toX, top: y, bottom: y + 4 });
  }

  time(system, staff, x, beats, beatType) {
    this.glyph(0xe080 + beats, x, this.y(system, staff, 2));
    this.glyph(0xe080 + beatType, x, this.y(system, staff, 6));
  }

  key(system, staff, x, kind, steps) {
    steps.forEach((step, index) => this.glyph(CODES[kind], x + index * SPACE, this.y(system, staff, step)));
  }

  done() {
    return { width: 600, height: 800, glyphs: this.glyphs, lines: this.lines, shapes: this.shapes };
  }
}

const names = (measure, staff = 0) =>
  measure.entries
    .filter((entry) => entry.staff === staff)
    .sort((a, b) => a.onset - b.onset || (a.kind === "rest" ? -1 : 1))
    .map((entry) => `${entry.onset}:${entry.kind === "rest" ? "rest" : entry.heads.map((head) => `${head.stepName}${{ "-1": "b", 1: "#", 0: "" }[head.alter]}${head.octave}`).join("+")}/${entry.duration}`);

test("reads pitches from where notes sit on the staff", () => {
  const page = new Page();
  const system = page.system(100, ["treble"], [300]);
  page.time(system, 0, 85, 4, 4);
  // Treble staff, counting down from the top line F5: steps 10, 9, 8, 7 are C4 D4 E4 F4.
  [10, 9, 8, 7].forEach((step, index) => page.note(system, 0, 120 + index * 40, step));
  [6, 0, -2, 3].forEach((step, index) => page.note(system, 0, 320 + index * 50, step, { stem: "down" }));
  const score = recognizeScore([page.done()]);
  assert.equal(score.measures.length, 2);
  assert.deepEqual(names(score.measures[0]), ["0:C4/1", "1:D4/1", "2:E4/1", "3:F4/1"]);
  assert.deepEqual(names(score.measures[1]), ["0:G4/1", "1:F5/1", "2:A5/1", "3:C5/1"]);
  assert.deepEqual(score.warnings, []);
});

test("reads the bass clef and keeps a chord on the staff its stem belongs to", () => {
  const page = new Page();
  const system = page.system(100, ["treble", "bass"], [300], { gap: SPACE * 6 });
  page.time(system, 0, 85, 3, 4);
  page.note(system, 0, 120, 4, { head: "half", dots: 1 });
  // A3 on the top line of the bass staff, with E4 and A4 on ledger lines reaching up toward the treble staff.
  page.rest(system, 1, 120);
  page.note(system, 1, 170, [0, -4, -7], { head: "half" });
  page.note(system, 0, 320, 4, { head: "half", dots: 1 });
  page.note(system, 1, 320, 8, { head: "half", dots: 1, stem: "down" });
  const score = recognizeScore([page.done()]);
  assert.equal(score.staves, 2);
  assert.deepEqual(names(score.measures[0], 0), ["0:B4/3"]);
  assert.deepEqual(names(score.measures[0], 1), ["0:rest/1", "1:A3+E4+A4/2"]);
  assert.deepEqual(names(score.measures[1], 1), ["0:G2/3"]);
});

test("applies the key signature, and accidentals for the rest of their measure only", () => {
  const page = new Page();
  const system = page.system(100, ["treble"], [320]);
  page.key(system, 0, 75, "flat", [4, 1]); // B flat and E flat
  page.time(system, 0, 95, 4, 4);
  page.note(system, 0, 130, 4); // B flat from the key
  page.note(system, 0, 170, 4, { accidental: "natural" });
  page.note(system, 0, 210, 4); // still natural
  page.note(system, 0, 250, 1); // E flat from the key
  page.note(system, 0, 340, 4, { head: "whole" }); // back to B flat
  const score = recognizeScore([page.done()]);
  assert.equal(score.measures[0].fifths, -2);
  assert.deepEqual(names(score.measures[0]), ["0:Bb4/1", "1:B4/1", "2:B4/1", "3:Eb5/1"]);
  assert.deepEqual(names(score.measures[1]), ["0:Bb4/4"]);
});

test("reads rhythm from beams, flags and dots", () => {
  const page = new Page();
  const system = page.system(100, ["treble"], [330]);
  page.time(system, 0, 85, 4, 4);
  page.note(system, 0, 115, 6, { dots: 1 });
  page.note(system, 0, 165, 5, { flag: true });
  const a = page.note(system, 0, 200, 4);
  const b = page.note(system, 0, 230, 3);
  page.beam(a, b);
  page.rest(system, 0, 265, "eighthRest");
  page.note(system, 0, 295, 2, { flag: true, stem: "down" });
  // Sixteenths: two beams.
  const group = [350, 375, 400, 425].map((x, index) => page.note(system, 0, x, 6 - index, { length: 4 }));
  page.beam(group[0], group[3]);
  page.beam({ x: group[0].x, tip: group[0].tip + SPACE * 0.8 }, { x: group[3].x, tip: group[3].tip + SPACE * 0.8 });
  page.note(system, 0, 460, 4, { head: "half", dots: 1 });
  const score = recognizeScore([page.done()]);
  assert.deepEqual(names(score.measures[0]), ["0:G4/1.5", "1.5:A4/0.5", "2:B4/0.5", "2.5:C5/0.5", "3:rest/0.5", "3.5:D5/0.5"]);
  assert.deepEqual(names(score.measures[1]), ["0:G4/0.25", "0.25:A4/0.25", "0.5:B4/0.25", "0.75:C5/0.25", "1:B4/3"]);
  assert.deepEqual(score.warnings, []);
});

test("reads triplets", () => {
  const page = new Page();
  const system = page.system(100, ["treble"], []);
  page.time(system, 0, 85, 2, 4);
  const group = [120, 150, 180].map((x) => page.note(system, 0, x, 4));
  page.beam(group[0], group[2]);
  page.glyph(CODES.three, 155, 100 - SPACE * 3, SPACE * 3);
  page.note(system, 0, 230, 4);
  const [measure] = recognizeScore([page.done()]).measures;
  assert.deepEqual(names(measure).map((name) => name.split("/")[0]), ["0:B4", "0.3333333333333333:B4", "0.6666666666666666:B4", "1:B4"]);
  assert.ok(Math.abs(measure.length - 2) < 1e-9);
});

test("times two voices on one staff from the columns they share", () => {
  const page = new Page();
  const system = page.system(100, ["treble", "bass"], []);
  page.time(system, 0, 85, 3, 4);
  [4, 3, 2].forEach((step, index) => page.note(system, 0, 120 + index * 60, step));
  page.rest(system, 1, 118);
  page.note(system, 1, 120, 9, { head: "half", dots: 1, stem: "down" });
  page.note(system, 1, 180, [3, 1, -1], { head: "half" });
  const score = recognizeScore([page.done()]);
  assert.deepEqual(names(score.measures[0], 1), ["0:rest/1", "0:F2/3", "1:E3+G3+B3/2"]);
  const parsed = parseScore(pdfToMusicXml([page.done()]).xml);
  const left = parsed.events.filter((event) => event.hand === "left");
  assert.deepEqual(left.map((event) => [event.time, event.notes.map((note) => note.note).join("+")]), [[0, "F2"], [1, "E3+G3+B3"]]);
});

test("a whole rest fills its measure whatever the time signature", () => {
  const page = new Page();
  const system = page.system(100, ["treble", "bass"], []);
  page.time(system, 0, 85, 3, 4);
  [4, 3, 2].forEach((step, index) => page.note(system, 0, 120 + index * 60, step));
  page.rest(system, 1, 300, "wholeRest");
  const [measure] = recognizeScore([page.done()]).measures;
  assert.deepEqual(names(measure, 1), ["0:rest/3"]);
  assert.equal(measure.length, 3);
});

test("finds ties, within a line and across a line break", () => {
  const page = new Page();
  const first = page.system(100, ["treble"], [300]);
  page.time(first, 0, 85, 2, 4);
  page.note(first, 0, 120, 4, { head: "half" });
  page.tie(first, 0, 120 + HEAD + 1, 320 - 1, 4);
  page.note(first, 0, 320, 4, { head: "half" });
  page.tie(first, 0, 320 + HEAD + 1, 550, 4); // runs off the end of the line
  const second = page.system(300, ["treble"], [300]);
  page.tie(second, 0, 80, 120 - 1, 4); // and arrives on the next
  page.note(second, 0, 120, 4, { head: "half" });
  page.note(second, 0, 320, 3, { head: "half" });
  // A slur to a different pitch is not a tie.
  page.tie(second, 0, 120 + HEAD + 1, 320 - 1, 4);
  const score = recognizeScore([page.done()]);
  const heads = score.measures.flatMap((measure) => measure.entries.flatMap((entry) => entry.heads));
  assert.deepEqual(heads.map((head) => [Boolean(head.tieStop), Boolean(head.tieStart)]), [[false, true], [true, true], [true, false], [false, false]]);
  const parsed = parseScore(pdfToMusicXml([page.done()]).xml);
  assert.deepEqual(parsed.events.map((event) => event.attack), [true, false, false, true]);
});

test("reports measures whose rhythm does not add up", () => {
  const page = new Page();
  const system = page.system(100, ["treble"], [200, 400]);
  page.time(system, 0, 85, 4, 4);
  page.note(system, 0, 120, 4, { head: "whole" });
  [220, 260, 300].forEach((x) => page.note(system, 0, x, 4)); // one beat short
  page.note(system, 0, 420, 4, { head: "whole" });
  const score = recognizeScore([page.done()]);
  assert.equal(score.warnings.length, 1);
  assert.match(score.warnings[0], /Measure 2 did not add up/);
});

test("a short first measure is a pickup, not a mistake", () => {
  const page = new Page();
  const system = page.system(100, ["treble"], [200]);
  page.time(system, 0, 85, 4, 4);
  page.note(system, 0, 150, 4);
  page.note(system, 0, 230, 4, { head: "whole" });
  const score = recognizeScore([page.done()]);
  assert.deepEqual(score.warnings, []);
  assert.equal(score.measures[0].pickup, true);
  const parsed = parseScore(pdfToMusicXml([page.done()]).xml);
  assert.deepEqual(parsed.events.map((event) => event.time), [0, 1]);
});

test("reads the title, composer and tempo, and leaves out download stamps", () => {
  const page = new Page();
  page.text("1 copy downloaded by someone@example.com", 40, 12, 8, "Helvetica");
  page.text("Morning Song", 200, 50, 22);
  page.text("A. Composer", 470, 70, 10);
  page.glyph(0xeca5, 60, 90, SPACE * 4, "LelandText");
  page.text("= 92", 70, 90, 11);
  const system = page.system(100, ["treble"], []);
  page.time(system, 0, 85, 4, 4);
  page.note(system, 0, 120, 4, { head: "whole" });
  const read = pdfToMusicXml([page.done()]);
  assert.equal(read.title, "Morning Song");
  assert.equal(read.composer, "A. Composer");
  assert.ok(!read.xml.includes("example.com"));
  const parsed = parseScore(read.xml);
  assert.equal(parsed.title, "Morning Song");
  assert.equal(parsed.tempo, 92);
});

test("says plainly when a PDF has no music it can read", () => {
  const blank = { width: 600, height: 800, glyphs: [], lines: [], shapes: [] };
  assert.throws(() => recognizeScore([blank]), /only pictures of its pages/);
  const words = new Page();
  words.text("Minutes of the meeting", 50, 100, 12);
  assert.throws(() => recognizeScore([words.done()]), /No staves were found/);
  const empty = new Page();
  empty.system(100, ["treble"], [300]);
  assert.throws(() => recognizeScore([empty.done()]), /no notes/);
});

test("reads a piece set on four staves, two for each hand", () => {
  const page = new Page();
  const system = page.system(80, ["treble", "bass", "treble", "bass"], [300], { gap: SPACE * 5 });
  page.time(system, 0, 85, 2, 4);
  // First measure: only the bottom pair is used, as an ordinary grand staff.
  page.note(system, 2, 130, 4, { head: "half" }); // B4
  page.note(system, 3, 130, 2, { head: "half", stem: "down" }); // F3
  // Second measure: all four, a chord and an octave for each hand.
  page.note(system, 0, 330, 0, { head: "half" }); // F5
  page.note(system, 1, 330, 6, { head: "half", stem: "down" }); // B2
  page.note(system, 2, 330, 8, { head: "half" }); // E4
  page.note(system, 3, 330, 10, { head: "half", stem: "down" }); // E2
  const read = pdfToMusicXml([page.done()]);
  assert.deepEqual(read.warnings, []);
  const { events } = parseScore(read.xml);
  const hands = (time) => events.filter((event) => event.time === time).map((event) => `${event.hand}:${event.notes.map((note) => note.note).join("+")}`).sort();
  assert.deepEqual(hands(0), ["left:F3", "right:B4"]);
  assert.deepEqual(hands(2), ["left:E2+E4", "right:B2+F5"]);
});
