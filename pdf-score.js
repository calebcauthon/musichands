// Turns the drawing of a score (see pdf-reader.js) back into music.
//
// Notation programs draw every notehead, rest, clef and accidental as a
// character of a music font, using the standard SMuFL code points, and draw
// staff lines, stems and barlines as plain lines. So a PDF exported from one
// still says exactly what is on the page: this module finds the staves, reads
// each symbol's pitch from where it sits on them, works out the rhythm from
// note shapes, beams, flags and dots, and writes the result as MusicXML.
//
// It reads piano music on one or two staves. It does not read scanned pages,
// which hold only a picture of the score.

const NOTEHEADS = { 0xe0a0: 8, 0xe0a1: 8, 0xe0a2: 4, 0xe0a3: 2, 0xe0a4: 1 }; // length in quarter notes before beams and dots
const STEMLESS = new Set([0xe0a0, 0xe0a1, 0xe0a2]);
const RESTS = { 0xe4e2: 8, 0xe4e3: 4, 0xe4e4: 2, 0xe4e5: 1, 0xe4e6: 0.5, 0xe4e7: 0.25, 0xe4e8: 0.125, 0xe4e9: 0.0625 };
const WHOLE_REST = 0xe4e3;
const FLAGS = { 0xe240: 1, 0xe241: 1, 0xe242: 2, 0xe243: 2, 0xe244: 3, 0xe245: 3, 0xe246: 4, 0xe247: 4 };
const DOT = 0xe1e7;
const ACCIDENTALS = { 0xe260: -1, 0xe261: 0, 0xe262: 1, 0xe263: 2, 0xe264: -2 };
const ACCIDENTAL_NAMES = { "-2": "flat-flat", "-1": "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };
// Each clef's code, its MusicXML sign, and the diatonic number of the pitch on
// the line the glyph is anchored to (C4 is 28, one more for each step up).
const CLEFS = {
  0xe050: { sign: "G", anchor: 32 },
  0xe052: { sign: "G", anchor: 25, octave: -1 },
  0xe053: { sign: "G", anchor: 39, octave: 1 },
  0xe07a: { sign: "G", anchor: 32 },
  0xe062: { sign: "F", anchor: 24 },
  0xe064: { sign: "F", anchor: 17, octave: -1 },
  0xe07c: { sign: "F", anchor: 24 },
  0xe05c: { sign: "C", anchor: 28 },
  0xe07b: { sign: "C", anchor: 28 },
};
const TIME_DIGIT = (code) => (code >= 0xe080 && code <= 0xe089 ? code - 0xe080 : null);
const COMMON_TIME = 0xe08a;
const CUT_TIME = 0xe08b;
const TUPLET_DIGIT = (code) => (code >= 0xe880 && code <= 0xe889 ? code - 0xe880 : null);
const METRONOME = { 0xeca2: 4, 0xeca3: 2, 0xeca4: 2, 0xeca5: 1, 0xeca6: 1, 0xeca7: 0.5, 0xeca8: 0.5 };
const METRONOME_DOT = 0xecb7;
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B as steps above C
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
const STEP_NAMES = ["C", "D", "E", "F", "G", "A", "B"];
const TYPE_NAMES = { 8: "breve", 4: "whole", 2: "half", 1: "quarter", 0.5: "eighth", 0.25: "16th", 0.125: "32nd", 0.0625: "64th" };
const DIVISIONS = 48; // MusicXML ticks in a quarter note
const EPSILON = 1e-6;

const isMusic = (glyph) => glyph.code >= 0xe000 && glyph.code <= 0xf8ff;
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const byX = (a, b) => a.x - b.x;

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------- the page

// Staff lines are often drawn a measure at a time, so join the pieces.
function mergeHorizontal(lines) {
  const rows = new Map();
  for (const line of lines) {
    if (Math.abs(line.y1 - line.y2) > 0.05) continue;
    const key = Math.round(((line.y1 + line.y2) / 2) * 10);
    const row = rows.get(key) ?? rows.set(key, []).get(key);
    row.push([Math.min(line.x1, line.x2), Math.max(line.x1, line.x2)]);
  }
  const merged = [];
  for (const [key, spans] of rows) {
    spans.sort((a, b) => a[0] - b[0]);
    let current = spans[0].slice();
    for (const span of spans.slice(1)) {
      if (span[0] <= current[1] + 1) current[1] = Math.max(current[1], span[1]);
      else {
        merged.push({ y: key / 10, left: current[0], right: current[1] });
        current = span.slice();
      }
    }
    merged.push({ y: key / 10, left: current[0], right: current[1] });
  }
  return merged.sort((a, b) => a.y - b.y);
}

// Barlines and stems can be drawn in pieces too.
function mergeVertical(lines) {
  const columns = new Map();
  for (const line of lines) {
    if (Math.abs(line.x1 - line.x2) > 0.05) continue;
    const key = Math.round(((line.x1 + line.x2) / 2) * 10);
    const column = columns.get(key) ?? columns.set(key, []).get(key);
    column.push({ top: Math.min(line.y1, line.y2), bottom: Math.max(line.y1, line.y2), width: line.width });
  }
  const merged = [];
  for (const [key, spans] of columns) {
    spans.sort((a, b) => a.top - b.top);
    let current = { ...spans[0] };
    for (const span of spans.slice(1)) {
      if (span.top <= current.bottom + 0.5) {
        current.bottom = Math.max(current.bottom, span.bottom);
        current.width = Math.max(current.width, span.width);
      } else {
        merged.push({ x: key / 10, ...current });
        current = { ...span };
      }
    }
    merged.push({ x: key / 10, ...current });
  }
  return merged;
}

function findStaves(page) {
  const long = mergeHorizontal(page.lines).filter((line) => line.right - line.left > page.width * 0.25);
  const staves = [];
  let index = 0;
  while (index + 4 < long.length) {
    const group = long.slice(index, index + 5);
    const space = (group[4].y - group[0].y) / 4;
    const even = group.every((line, n) => near(line.y, group[0].y + n * space, space * 0.08));
    const aligned = group.every((line) => near(line.left, group[0].left, 2) && near(line.right, group[0].right, 2));
    if (space > 1.5 && space < 20 && even && aligned) {
      staves.push({ top: group[0].y, bottom: group[4].y, space, left: group[0].left, right: group[0].right });
      index += 5;
    } else {
      index += 1;
    }
  }
  return staves;
}

// Staves joined by a line down their left edge are played together.
function findSystems(page, staves) {
  const verticals = mergeVertical(page.lines);
  const systems = [];
  let current = null;
  for (const staff of staves) {
    const previous = current?.staves.at(-1);
    const joined =
      previous &&
      verticals.some((line) => near(line.x, staff.left, 1.5) && line.top <= previous.bottom + 0.5 && line.bottom >= staff.top - 0.5);
    if (joined) current.staves.push(staff);
    else {
      current = { staves: [staff] };
      systems.push(current);
    }
  }
  for (const system of systems) {
    const first = system.staves[0];
    const last = system.staves.at(-1);
    Object.assign(system, { top: first.top, bottom: last.bottom, left: first.left, right: first.right, space: first.space });
    const tolerance = system.space * 0.3;
    const xs = verticals
      .filter((line) => line.top <= system.top + tolerance && line.bottom >= system.bottom - tolerance && line.bottom - line.top < system.bottom - system.top + system.space * 2)
      .filter((line) => line.x > system.left + system.space)
      .map((line) => line.x)
      .sort((a, b) => a - b);
    // A double or final barline is two lines close together: keep the last of each group.
    const barlines = [];
    for (const x of xs) {
      if (barlines.length && x - barlines.at(-1) < system.space * 1.6) barlines[barlines.length - 1] = x;
      else barlines.push(x);
    }
    if (!barlines.length || barlines.at(-1) < system.right - system.space * 2) barlines.push(system.right);
    system.barlines = barlines;
    system.verticals = verticals.filter((line) => line.bottom >= system.top - system.space * 8 && line.top <= system.bottom + system.space * 8);
  }
  return systems;
}

// Hand each glyph and shape to the system it sits closest to.
function shareOut(page, systems) {
  for (const system of systems) Object.assign(system, { glyphs: [], shapes: [], text: [] });
  const nearest = (y) => {
    let best = systems[0];
    let distance = Infinity;
    for (const system of systems) {
      const d = y < system.top ? system.top - y : y > system.bottom ? y - system.bottom : 0;
      if (d < distance) {
        distance = d;
        best = system;
      }
    }
    return best;
  };
  for (const glyph of page.glyphs) (isMusic(glyph) ? nearest(glyph.y).glyphs : nearest(glyph.y).text).push(glyph);
  for (const shape of page.shapes) {
    if (shape.right - shape.left > page.width * 0.98) continue; // the page background
    nearest((shape.top + shape.bottom) / 2).shapes.push(shape);
  }
}

// ------------------------------------------------------------ the symbols

function staffOf(system, y) {
  let best = 0;
  let distance = Infinity;
  system.staves.forEach((staff, index) => {
    const d = y < staff.top ? staff.top - y : y > staff.bottom ? y - staff.bottom : 0;
    if (d < distance) {
      distance = d;
      best = index;
    }
  });
  return best;
}

const stepOn = (staff, y) => Math.round((y - staff.top) / (staff.space / 2));

function readSystem(system) {
  const space = system.space;
  const headWidth = space * 1.3;
  const normalSize = Math.max(...system.glyphs.filter((glyph) => NOTEHEADS[glyph.code] || RESTS[glyph.code] || CLEFS[glyph.code]).map((glyph) => glyph.size), 0);
  const fullSize = (glyph) => glyph.size >= normalSize * 0.85;
  const glyphs = system.glyphs.filter((glyph) => glyph.x >= system.left - space && glyph.x <= system.right + space);

  const heads = glyphs
    .filter((glyph) => NOTEHEADS[glyph.code] && fullSize(glyph))
    .map((glyph) => {
      const staff = staffOf(system, glyph.y);
      return { x: glyph.x, y: glyph.y, code: glyph.code, staff, step: stepOn(system.staves[staff], glyph.y), dots: new Set(), stem: null };
    });

  // Stems: upright lines that are not barlines and touch a notehead.
  const stems = system.verticals
    .filter((line) => line.bottom - line.top > space * 1.5 && !system.barlines.some((x) => near(x, line.x, 0.6)) && !near(line.x, system.left, 1.5))
    .map((line) => ({ x: line.x, top: line.top, bottom: line.bottom, heads: [] }));
  for (const head of heads) {
    if (STEMLESS.has(head.code)) continue;
    let best = null;
    for (const stem of stems) {
      if (head.y < stem.top - space * 0.4 || head.y > stem.bottom + space * 0.4) continue;
      const gap = Math.min(Math.abs(stem.x - head.x), Math.abs(stem.x - (head.x + headWidth)));
      if (gap < space * 0.3 && (!best || gap < best.gap)) best = { stem, gap };
    }
    if (best) {
      head.stem = best.stem;
      best.stem.heads.push(head);
    }
  }

  const beams = system.shapes.filter((shape) => !shape.curved && shape.filled && shape.points.length <= 6 && shape.right - shape.left > space);
  const beamAt = (beam, x) => {
    // The middle of the beam where it crosses x.
    const ys = [];
    for (let index = 1; index < beam.points.length; index += 1) {
      const [x1, y1] = beam.points[index - 1];
      const [x2, y2] = beam.points[index];
      if (Math.abs(x2 - x1) < 0.01) continue;
      const t = (x - x1) / (x2 - x1);
      if (t >= -0.05 && t <= 1.05) ys.push(y1 + (y2 - y1) * t);
    }
    return ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : null;
  };
  const flags = glyphs.filter((glyph) => FLAGS[glyph.code]);

  const chords = [];
  for (const stem of stems) {
    if (!stem.heads.length) continue;
    const ys = stem.heads.map((head) => head.y);
    const up = Math.min(...ys) - stem.top > stem.bottom - Math.max(...ys);
    const tip = up ? stem.top : stem.bottom;
    const crossing = beams.filter((beam) => {
      if (stem.x < beam.left - space * 0.25 || stem.x > beam.right + space * 0.25) return false;
      const y = beamAt(beam, Math.min(beam.right, Math.max(beam.left, stem.x)));
      return y !== null && y >= stem.top - space * 0.5 && y <= stem.bottom + space * 0.5 && Math.abs(y - tip) < space * 3.2;
    });
    const flag = flags.find((glyph) => near(glyph.x, stem.x, space * 0.5) && near(glyph.y, tip, space * 1.2));
    const tails = crossing.length || (flag ? FLAGS[flag.code] : 0);
    const base = NOTEHEADS[stem.heads[0].code];
    // Every note on a stem belongs to one staff: the one most of them sit
    // nearest, however far a ledger line carries the others toward its neighbour.
    const votes = system.staves.map((_, index) => stem.heads.filter((head) => head.staff === index).length);
    const staff = votes.indexOf(Math.max(...votes));
    for (const head of stem.heads) {
      head.staff = staff;
      head.step = stepOn(system.staves[staff], head.y);
    }
    chords.push({
      kind: "chord",
      heads: stem.heads.sort((a, b) => b.y - a.y),
      staff,
      x: up ? stem.x - headWidth : stem.x,
      up,
      stem,
      beams: crossing,
      base: base === 1 ? 1 / 2 ** tails : base,
    });
  }
  // Notes without stems: whole notes, stacked into chords by where they sit.
  const loose = heads.filter((head) => !head.stem).sort(byX);
  for (const head of loose) {
    const chord = chords.find((entry) => !entry.stem && entry.staff === head.staff && near(entry.x, head.x, space * 0.35));
    if (chord) chord.heads.push(head);
    else chords.push({ kind: "chord", heads: [head], staff: head.staff, x: head.x, up: null, stem: null, beams: [], base: NOTEHEADS[head.code] });
  }

  const rests = glyphs
    .filter((glyph) => RESTS[glyph.code] && fullSize(glyph))
    .map((glyph) => ({ kind: "rest", x: glyph.x, y: glyph.y, code: glyph.code, staff: staffOf(system, glyph.y), base: RESTS[glyph.code], dots: new Set() }));

  // Each dot lengthens the nearest note or rest to its left.
  for (const dot of glyphs.filter((glyph) => glyph.code === DOT)) {
    let best = null;
    for (const head of heads) {
      const gap = dot.x - (head.x + headWidth);
      if (gap < -space * 0.3 || gap > space * 3.5 || Math.abs(dot.y - head.y) > space * 0.8) continue;
      if (!best || gap < best.gap) best = { owner: head, gap };
    }
    for (const rest of rests) {
      const gap = dot.x - (rest.x + space);
      if (gap < -space * 0.3 || gap > space * 3 || Math.abs(dot.y - rest.y) > space * 1.6) continue;
      if (!best || gap < best.gap) best = { owner: rest, gap };
    }
    if (best) best.owner.dots.add(Math.round(dot.x / (space * 0.4)));
  }
  const dotted = (base, dots) => base * (2 - 1 / 2 ** dots);
  for (const chord of chords) {
    chord.dots = Math.max(...chord.heads.map((head) => head.dots.size));
    chord.duration = dotted(chord.base, chord.dots);
  }
  for (const rest of rests) {
    rest.dotCount = rest.dots.size;
    rest.duration = dotted(rest.base, rest.dotCount);
  }

  // Triplets and the like: a small number over a group of notes.
  for (const mark of glyphs.filter((glyph) => TUPLET_DIGIT(glyph.code) !== null)) {
    const count = TUPLET_DIGIT(mark.code);
    if (count !== 3 && count !== 6) continue;
    const group = [...chords, ...rests]
      .filter((entry) => entry.base < 2 && Math.abs(entry.x + headWidth / 2 - mark.x) < space * 9 && Math.abs(staffCenter(system, entry.staff) - mark.y) < space * 9)
      .sort((a, b) => Math.abs(a.x - mark.x) - Math.abs(b.x - mark.x))
      .slice(0, 3);
    if (group.length === 3 && new Set(group.map((entry) => entry.base)).size === 1) {
      for (const entry of group) {
        entry.tuplet = 3;
        entry.duration = (entry.duration * 2) / 3;
      }
    }
  }

  const accidentals = glyphs
    .filter((glyph) => glyph.code in ACCIDENTALS && fullSize(glyph))
    .map((glyph) => {
      const staff = staffOf(system, glyph.y);
      return { x: glyph.x, y: glyph.y, alter: ACCIDENTALS[glyph.code], staff, step: stepOn(system.staves[staff], glyph.y), used: false };
    });
  const clefs = glyphs
    .filter((glyph) => CLEFS[glyph.code])
    .map((glyph) => {
      const staff = staffOf(system, glyph.y);
      const clef = CLEFS[glyph.code];
      const line = stepOn(system.staves[staff], glyph.y);
      return { x: glyph.x, staff, sign: clef.sign, octave: clef.octave ?? 0, line: 5 - line / 2, top: clef.anchor + line };
    })
    .sort(byX);
  const timeMarks = glyphs.filter((glyph) => TIME_DIGIT(glyph.code) !== null || glyph.code === COMMON_TIME || glyph.code === CUT_TIME);
  const curves = system.shapes.filter((shape) => shape.curved && shape.filled);
  return { chords, rests, accidentals, clefs, timeMarks, curves, headWidth };
}

const staffCenter = (system, index) => (system.staves[index].top + system.staves[index].bottom) / 2;

// A run of sharps or flats with nothing between them, starting at or after x.
function keyRun(accidentals, staff, from, space, reach) {
  const run = [];
  let edge = from;
  let limit = reach;
  for (const mark of accidentals.filter((entry) => entry.staff === staff && !entry.used && entry.x >= from - 0.1).sort(byX)) {
    if (mark.x - edge > limit) break;
    if (run.length && (mark.alter === 0) !== (run[0].alter === 0)) break;
    run.push(mark);
    edge = mark.x;
    limit = space * 1.7;
  }
  return run;
}

function readTime(marks, staff, from, to, system) {
  const here = marks.filter((glyph) => glyph.x >= from && glyph.x < to && staffOf(system, glyph.y) === staff).sort(byX);
  if (!here.length) return null;
  if (here[0].code === COMMON_TIME) return { beats: 4, beatType: 4, x: here[0].x };
  if (here[0].code === CUT_TIME) return { beats: 2, beatType: 2, x: here[0].x };
  const middle = staffCenter(system, staff);
  const digits = (list) => Number(list.map((glyph) => TIME_DIGIT(glyph.code)).join(""));
  const upper = here.filter((glyph) => glyph.y < middle);
  const lower = here.filter((glyph) => glyph.y >= middle);
  if (!upper.length || !lower.length) return null;
  return { beats: digits(upper), beatType: digits(lower), x: here[0].x };
}

// ------------------------------------------------------------- the rhythm

// Notes printed in the same column start together, and a new column starts
// the moment the shortest note still sounding runs out.
function sweep(entries, tolerance) {
  const sorted = [...entries].sort(byX);
  const columns = [];
  for (const entry of sorted) {
    const column = columns.at(-1);
    if (column && entry.x - column.x <= tolerance) column.entries.push(entry);
    else columns.push({ x: entry.x, entries: [entry] });
  }
  const onsets = new Map();
  const ends = [];
  let time = 0;
  for (const column of columns) {
    if (column !== columns[0]) {
      const later = ends.filter((end) => end > time + EPSILON);
      if (!later.length) return null;
      time = Math.min(...later);
    }
    for (const entry of column.entries) {
      onsets.set(entry, time);
      ends.push(time + entry.duration);
    }
  }
  return { onsets, length: ends.length ? Math.max(...ends) : 0 };
}

function timeMeasure(measure, expected, space) {
  const fills = measure.entries.filter((entry) => entry.kind === "rest" && entry.code === WHOLE_REST && !measure.entries.some((other) => other !== entry && other.staff === entry.staff));
  const timed = measure.entries.filter((entry) => !fills.includes(entry));
  let best = null;
  for (const tolerance of [0.75, 1.35, 0.4, 2]) {
    const result = sweep(timed, tolerance * space);
    if (!result) continue;
    const miss = Math.abs(result.length - expected);
    if (!best || miss < best.miss - EPSILON) best = { ...result, miss };
    if (miss < EPSILON) break;
  }
  best ??= { onsets: new Map(timed.map((entry) => [entry, 0])), length: 0, miss: expected };
  for (const entry of timed) entry.onset = best.onsets.get(entry) ?? 0;
  const length = timed.length ? best.length : expected;
  for (const entry of fills) {
    entry.onset = 0;
    entry.duration = Math.max(length, expected);
    entry.wholeMeasure = true;
  }
  measure.length = length;
  measure.exact = !timed.length || best.miss < EPSILON;
}

// ------------------------------------------------------------ the reading

function readText(pages) {
  const page = pages[0];
  const glyphs = page.glyphs.filter((glyph) => !isMusic(glyph)).sort((a, b) => a.y - b.y || a.x - b.x);
  const runs = [];
  for (const glyph of glyphs) {
    const run = runs.find((entry) => entry.font === glyph.font && near(entry.size, glyph.size, 0.1) && near(entry.y, glyph.y, 0.5) && glyph.x - entry.right < glyph.size * 1.2 && glyph.x >= entry.right - glyph.size);
    const width = glyph.width ?? glyph.size * 0.5;
    if (run) {
      if (glyph.x - run.right > glyph.size * 0.12) run.text += " ";
      run.text += glyph.text;
      run.right = glyph.x + width;
    } else {
      runs.push({ text: glyph.text, font: glyph.font, size: glyph.size, x: glyph.x, y: glyph.y, right: glyph.x + width });
    }
  }
  return runs;
}

function readTitles(pages, firstTop) {
  const runs = readText(pages).filter((run) => run.y < firstTop && run.text.trim().length > 1);
  // Leave out the stamps a download service prints across the top of the page.
  const printed = runs.filter((run) => !/downloaded|copyright|©|prohibited|@/i.test(run.text));
  const title = [...printed].sort((a, b) => b.size - a.size)[0];
  const width = pages[0].width;
  const composer = printed
    .filter((run) => run !== title && run.right > width * 0.72 && run.size < (title?.size ?? 99) && !/=/.test(run.text))
    .sort((a, b) => b.right - a.right)[0];
  return { title: title?.text.trim() ?? "", composer: composer?.text.trim() ?? "" };
}

function readTempo(pages) {
  const page = pages[0];
  const mark = page.glyphs.find((glyph) => METRONOME[glyph.code]);
  if (!mark) return null;
  const dot = page.glyphs.some((glyph) => glyph.code === METRONOME_DOT && near(glyph.y, mark.y, mark.size) && glyph.x > mark.x && glyph.x - mark.x < mark.size);
  const after = page.glyphs
    .filter((glyph) => !isMusic(glyph) && near(glyph.y, mark.y, mark.size * 0.6) && glyph.x > mark.x && glyph.x - mark.x < mark.size * 5)
    .sort(byX)
    .map((glyph) => glyph.text)
    .join("");
  const match = after.match(/=\s*(\d{2,3})/);
  if (!match) return null;
  const unit = METRONOME[mark.code] * (dot ? 1.5 : 1);
  return { perMinute: Number(match[1]), unit, dotted: dot, quarters: Number(match[1]) * unit };
}

// Reads the pages of a score into measures of timed notes.
export function recognizeScore(pages) {
  const warnings = [];
  const systems = [];
  pages.forEach((page, pageIndex) => {
    const staves = findStaves(page);
    if (!staves.length) return;
    const found = findSystems(page, staves);
    shareOut(page, found);
    for (const system of found) systems.push({ ...system, page: pageIndex });
  });
  if (!systems.length) {
    const anyGlyphs = pages.some((page) => page.glyphs.length > 0);
    throw new Error(
      anyGlyphs
        ? "No staves were found in this PDF. It may not be sheet music, or it may draw its staves in a way this reader does not know."
        : "This PDF holds only pictures of its pages, so there are no notes in it to read. Scanned scores cannot be imported.",
    );
  }
  const staffCount = Math.min(2, Math.max(...systems.map((system) => system.staves.length)));
  if (systems.some((system) => system.staves.length > 2)) warnings.push("Some systems have more than two staves; only the top two were read.");
  for (const system of systems) {
    if (system.staves.length > 2) {
      system.staves = system.staves.slice(0, 2);
      system.bottom = system.staves.at(-1).bottom;
    }
  }

  const state = { clefs: [], fifths: 0, time: { beats: 4, beatType: 4 }, timeKnown: false };
  const measures = [];
  let openTies = []; // ties that ran off the end of the last system

  systems.forEach((system, systemIndex) => {
    const space = system.space;
    const read = readSystem(system);
    const edges = [system.left, ...system.barlines];

    // The start of every system restates the clefs and the key.
    for (let staff = 0; staff < system.staves.length; staff += 1) {
      const clef = read.clefs.find((entry) => entry.staff === staff && entry.x < system.left + space * 6);
      if (clef) state.clefs[staff] = clef;
      else if (!state.clefs[staff]) {
        state.clefs[staff] = staff === 0 ? { sign: "G", line: 2, top: 38, octave: 0 } : { sign: "F", line: 4, top: 26, octave: 0 };
        warnings.push(`No clef was found for staff ${staff + 1}; assumed ${staff === 0 ? "treble" : "bass"}.`);
      }
      const from = (clef?.x ?? system.left) + space * 1.5;
      const run = keyRun(read.accidentals, staff, from, space, space * 4.5);
      run.forEach((mark) => (mark.used = true));
      if (staff === 0) state.fifths = run.length ? run.length * (run[0].alter > 0 ? 1 : run[0].alter < 0 ? -1 : 0) : 0;
    }

    for (let index = 0; index < edges.length - 1; index += 1) {
      const [left, right] = [edges[index], edges[index + 1]];
      const inside = (entry) => entry.x >= left - space * 0.2 && entry.x < right - space * 0.2;
      const measure = { system: systemIndex, first: index === 0, newPage: index === 0 && system.page !== systems[systemIndex - 1]?.page, left, right, attributes: {}, entries: [] };

      // A change of key shows as sharps, flats or naturals straight after the barline.
      if (index > 0) {
        const run = keyRun(read.accidentals, 0, left, space, space * 2.2).filter((mark) => !read.chords.some((chord) => chord.heads.some((head) => head.staff === mark.staff && head.step === mark.step && head.x > mark.x && head.x - mark.x < space * 4.5)));
        if (run.length && run.length === keyRun(read.accidentals, 0, left, space, space * 2.2).length) {
          const signs = run.filter((mark) => mark.alter !== 0);
          const fifths = signs.length * (signs[0]?.alter > 0 ? 1 : -1) || 0;
          for (let staff = 0; staff < system.staves.length; staff += 1) keyRun(read.accidentals, staff, left, space, space * 2.2).forEach((mark) => (mark.used = true));
          if (fifths !== state.fifths) {
            state.fifths = fifths;
            measure.attributes.fifths = fifths;
          }
        }
      }
      const time = readTime(read.timeMarks, 0, left, right, system);
      if (time && (time.beats !== state.time.beats || time.beatType !== state.time.beatType || !state.timeKnown)) {
        state.time = { beats: time.beats, beatType: time.beatType };
        state.timeKnown = true;
        measure.attributes.time = state.time;
      }
      if (!measures.length) {
        measure.attributes.fifths = state.fifths;
        measure.attributes.time = state.time;
        measure.attributes.clefs = state.clefs.slice(0, staffCount).map((clef) => ({ ...clef }));
      }
      measure.fifths = state.fifths;
      measure.time = { ...state.time };

      // Clef changes inside the system.
      for (const clef of read.clefs.filter((entry) => inside(entry) && entry.x >= system.left + space * 6)) {
        measure.clefChanges ??= [];
        measure.clefChanges.push(clef);
      }
      measure.entries = [...read.chords, ...read.rests].filter((entry) => inside(entry) && entry.staff < staffCount);
      measure.accidentals = read.accidentals.filter((mark) => inside(mark) && !mark.used);
      measure.curves = read.curves;
      measure.headWidth = read.headWidth;
      measure.space = space;
      measure.systemRight = system.right;
      measures.push(measure);
    }
  });

  // Pitches, reading each staff from left to right so accidentals carry
  // through the measure the way they do for a player.
  const clefNow = [];
  for (const measure of measures) {
    if (measure.attributes.clefs) measure.attributes.clefs.forEach((clef, staff) => (clefNow[staff] = clef));
    const keyAlter = new Array(7).fill(0);
    const order = measure.fifths > 0 ? SHARP_ORDER : FLAT_ORDER;
    for (let n = 0; n < Math.abs(measure.fifths); n += 1) keyAlter[order[n]] = measure.fifths > 0 ? 1 : -1;
    for (let staff = 0; staff < 2; staff += 1) {
      const changes = (measure.clefChanges ?? []).filter((clef) => clef.staff === staff).sort(byX);
      const sounding = new Map();
      const chords = measure.entries.filter((entry) => entry.kind === "chord").sort(byX);
      for (const chord of chords) {
        for (const head of chord.heads.filter((entry) => entry.staff === staff)) {
          for (const clef of changes) if (clef.x < head.x) clefNow[staff] = clef;
          const clef = clefNow[staff] ?? { top: staff === 0 ? 38 : 26 };
          const number = clef.top - head.step;
          const mark = measure.accidentals
            .filter((entry) => entry.staff === staff && entry.step === head.step && entry.x < head.x && head.x - entry.x < measure.space * 5)
            .sort((a, b) => b.x - a.x)[0];
          if (mark) {
            mark.used = true;
            sounding.set(number, mark.alter);
            head.accidental = mark.alter;
          }
          const index = ((number % 7) + 7) % 7;
          head.number = number;
          head.alter = sounding.has(number) ? sounding.get(number) : keyAlter[index];
          head.stepName = STEP_NAMES[index];
          head.octave = Math.floor(number / 7);
          head.midi = 12 * (head.octave + 1) + [0, 2, 4, 5, 7, 9, 11][index] + head.alter;
        }
      }
      for (const clef of changes) clefNow[staff] = clef;
    }
  }

  // Rhythm.
  measures.forEach((measure, index) => {
    const expected = (measure.time.beats * 4) / measure.time.beatType;
    timeMeasure(measure, expected, measure.space);
    const pickup = index === 0 && measure.exact === false && measure.length > 0 && measure.length < expected;
    if (pickup) measure.pickup = true;
    else if (!measure.exact || Math.abs(measure.length - expected) > EPSILON) {
      measure.doubtful = true;
    }
  });
  const doubtful = measures.map((measure, index) => (measure.doubtful ? index + 1 : null)).filter(Boolean);
  if (doubtful.length) {
    warnings.push(`${doubtful.length === 1 ? "Measure" : "Measures"} ${doubtful.slice(0, 12).join(", ")}${doubtful.length > 12 ? " and more" : ""} did not add up to a full measure, so ${doubtful.length === 1 ? "its" : "their"} rhythm may be wrong.`);
  }
  let start = 0;
  for (const measure of measures) {
    measure.start = start;
    const expected = (measure.time.beats * 4) / measure.time.beatType;
    measure.span = measure.pickup ? measure.length : Math.max(expected, measure.length);
    start += measure.span;
  }

  // Ties: a short curve from a notehead to the next notehead of the same pitch.
  const allHeads = [];
  for (const measure of measures) {
    for (const chord of measure.entries.filter((entry) => entry.kind === "chord")) {
      for (const head of chord.heads) allHeads.push({ head, chord, measure, start: measure.start + chord.onset, end: measure.start + chord.onset + chord.duration });
    }
  }
  const seen = new Set();
  for (const measure of measures) {
    if (seen.has(measure.curves)) continue;
    seen.add(measure.curves);
    const space = measure.space;
    const local = allHeads.filter((entry) => entry.measure.system === measure.system);
    // A tie carried over from the line above starts before the first note of this one.
    const firstNote = Math.min(...local.map((entry) => entry.head.x));
    const arriving = [];
    for (const curve of measure.curves) {
      const ends = [curve.points[0], curve.points[3] ?? curve.points.at(-1)].sort((a, b) => a[0] - b[0]);
      const [from, to] = ends;
      const leaving = local
        .filter(({ head }) => Math.abs(from[1] - head.y) < space * 0.9 && from[0] > head.x + measure.headWidth * 0.3 && from[0] < head.x + measure.headWidth + space * 2.6)
        .sort((a, b) => b.head.x - a.head.x)[0];
      const landing = local
        .filter(({ head }) => Math.abs(to[1] - head.y) < space * 0.9 && to[0] > head.x - space * 1.6 && to[0] < head.x + measure.headWidth * 0.7)
        .sort((a, b) => a.head.x - b.head.x)[0];
      if (leaving && landing && leaving.head.number === landing.head.number && leaving.head.staff === landing.head.staff && Math.abs(landing.start - leaving.end) < EPSILON) {
        leaving.head.tieStart = true;
        landing.head.tieStop = true;
        landing.head.alter = leaving.head.alter;
        landing.head.midi = leaving.head.midi;
      } else if (leaving && !landing && to[0] > measure.systemRight - space * 2) {
        leaving.open = true;
        arriving.push(leaving);
      } else if (landing && !leaving && from[0] < firstNote) {
        const match = openTies.find((entry) => entry.head.number === landing.head.number && entry.head.staff === landing.head.staff && Math.abs(landing.start - entry.end) < EPSILON);
        if (match) {
          match.head.tieStart = true;
          landing.head.tieStop = true;
          landing.head.alter = match.head.alter;
          landing.head.midi = match.head.midi;
        }
      }
    }
    openTies = arriving;
  }

  const firstTop = systems[0].top - systems[0].space * 2;
  const { title, composer } = readTitles(pages, firstTop);
  const tempo = readTempo(pages);
  const notes = allHeads.length;
  if (!notes) throw new Error("Staves were found in this PDF, but no notes. Its music may be drawn in a font this reader does not know.");
  return { title, composer, tempo, staves: staffCount, measures, warnings, notes };
}

// -------------------------------------------------------------- the score

const ticks = (quarters) => Math.round(quarters * DIVISIONS);

function noteType(entry) {
  const name = TYPE_NAMES[entry.base];
  return name ? `<type>${name}</type>` : "";
}

function beamMarks(entry, lane) {
  if (!entry.beams?.length) return "";
  const group = lane.filter((other) => other.kind === "chord" && other.beams?.includes(entry.beams[0]));
  const at = group.indexOf(entry);
  if (group.length < 2) return "";
  return `<beam number="1">${at === 0 ? "begin" : at === group.length - 1 ? "end" : "continue"}</beam>`;
}

function writeEntry(entry, lane, voice, staff) {
  const duration = `<duration>${ticks(entry.duration)}</duration>`;
  const dots = "<dot/>".repeat(entry.kind === "rest" ? entry.dotCount ?? 0 : entry.dots ?? 0);
  const tuplet = entry.tuplet ? "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" : "";
  if (entry.kind === "rest") {
    const rest = entry.wholeMeasure ? '<rest measure="yes"/>' : "<rest/>";
    return `<note>${rest}${duration}<voice>${voice}</voice>${entry.wholeMeasure ? "" : noteType(entry)}${dots}${tuplet}<staff>${staff}</staff></note>`;
  }
  const stem = entry.up === null ? "" : `<stem>${entry.up ? "up" : "down"}</stem>`;
  return [...entry.heads]
    .sort((a, b) => a.midi - b.midi)
    .map((head, index) => {
      const alter = head.alter ? `<alter>${head.alter}</alter>` : "";
      const ties = `${head.tieStop ? '<tie type="stop"/>' : ""}${head.tieStart ? '<tie type="start"/>' : ""}`;
      const tied = head.tieStop || head.tieStart ? `<notations>${head.tieStop ? '<tied type="stop"/>' : ""}${head.tieStart ? '<tied type="start"/>' : ""}</notations>` : "";
      const accidental = head.accidental === undefined ? "" : `<accidental>${ACCIDENTAL_NAMES[head.accidental]}</accidental>`;
      return `<note>${index ? "<chord/>" : ""}<pitch><step>${head.stepName}</step>${alter}<octave>${head.octave}</octave></pitch>${duration}${ties}<voice>${voice}</voice>${noteType(entry)}${dots}${accidental}${tuplet}${stem}<staff>${head.staff + 1}</staff>${index ? "" : beamMarks(entry, lane)}${tied}</note>`;
    })
    .join("\n      ");
}

// Notes that overlap on one staff are written as separate voices.
function lanesFor(entries) {
  const lanes = [];
  const sorted = [...entries].sort((a, b) => a.onset - b.onset || (a.up === false ? 1 : 0) - (b.up === false ? 1 : 0));
  for (const entry of sorted) {
    const lane = lanes.find((candidate) => candidate.end <= entry.onset + EPSILON && (candidate.up === undefined || entry.up === null || entry.up === undefined || candidate.up === entry.up || !sorted.some((other) => other !== entry && other.up === candidate.up && other.onset >= entry.onset)));
    if (lane) {
      lane.entries.push(entry);
      lane.end = entry.onset + entry.duration;
      if (entry.kind === "chord" && entry.up !== null) lane.up = entry.up;
    } else {
      lanes.push({ entries: [entry], end: entry.onset + entry.duration, up: entry.kind === "chord" && entry.up !== null ? entry.up : undefined });
    }
  }
  return lanes;
}

export function scoreToMusicXml(score) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="3.1">');
  out.push(`  <work><work-title>${escapeXml(score.title || "Untitled")}</work-title></work>`);
  out.push(`  <identification>${score.composer ? `<creator type="composer">${escapeXml(score.composer)}</creator>` : ""}<encoding><software>MusicHands PDF import</software></encoding></identification>`);
  out.push('  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>');
  out.push('  <part id="P1">');
  score.measures.forEach((measure, index) => {
    out.push(`    <measure number="${measure.pickup ? 0 : index + (score.measures[0].pickup ? 0 : 1)}"${measure.pickup ? ' implicit="yes"' : ""}>`);
    if (measure.first && index > 0) out.push(`      <print ${measure.newPage ? 'new-page="yes"' : 'new-system="yes"'}/>`);
    const { fifths, time, clefs } = measure.attributes;
    if (index === 0 || fifths !== undefined || time || clefs) {
      out.push("      <attributes>");
      if (index === 0) out.push(`        <divisions>${DIVISIONS}</divisions>`);
      if (fifths !== undefined) out.push(`        <key><fifths>${fifths}</fifths></key>`);
      if (time) out.push(`        <time><beats>${time.beats}</beats><beat-type>${time.beatType}</beat-type></time>`);
      if (index === 0) out.push(`        <staves>${score.staves}</staves>`);
      for (const [staff, clef] of (clefs ?? []).entries()) {
        out.push(`        <clef number="${staff + 1}"><sign>${clef.sign}</sign><line>${clef.line}</line>${clef.octave ? `<clef-octave-change>${clef.octave}</clef-octave-change>` : ""}</clef>`);
      }
      out.push("      </attributes>");
    }
    if (index === 0 && score.tempo) {
      const unit = TYPE_NAMES[score.tempo.dotted ? score.tempo.unit / 1.5 : score.tempo.unit] ?? "quarter";
      out.push(`      <direction placement="above"><direction-type><metronome><beat-unit>${unit}</beat-unit>${score.tempo.dotted ? "<beat-unit-dot/>" : ""}<per-minute>${score.tempo.perMinute}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${score.tempo.quarters}"/></direction>`);
    }
    let cursor = 0;
    let voice = 0;
    for (let staff = 0; staff < score.staves; staff += 1) {
      const entries = measure.entries.filter((entry) => entry.staff === staff);
      const clefChanges = (measure.clefChanges ?? []).filter((clef) => clef.staff === staff);
      for (const clef of clefChanges) {
        out.push(`      <attributes><clef number="${staff + 1}"><sign>${clef.sign}</sign><line>${clef.line}</line></clef></attributes>`);
      }
      const lanes = lanesFor(entries);
      lanes.forEach((lane, laneIndex) => {
        voice = staff * 4 + laneIndex + 1;
        if (cursor > EPSILON) out.push(`      <backup><duration>${ticks(cursor)}</duration></backup>`);
        cursor = 0;
        for (const entry of lane.entries) {
          if (entry.onset > cursor + EPSILON) out.push(`      <forward><duration>${ticks(entry.onset - cursor)}</duration><voice>${voice}</voice><staff>${staff + 1}</staff></forward>`);
          out.push(`      ${writeEntry(entry, lane.entries, voice, staff + 1)}`);
          cursor = entry.onset + entry.duration;
        }
      });
    }
    out.push("    </measure>");
  });
  out.push("  </part>");
  out.push("</score-partwise>");
  return out.join("\n");
}

// Reads the drawing of a score and returns it as MusicXML, with a plain
// account of anything that could not be read with confidence.
export function pdfToMusicXml(pages) {
  const score = recognizeScore(pages);
  return { xml: scoreToMusicXml(score), title: score.title, composer: score.composer, tempo: score.tempo, measures: score.measures.length, notes: score.notes, warnings: score.warnings };
}
