// Writes a short piece as MusicXML, the way score-model.js reads one: a
// piano part on two staves, the right hand on the upper, with each note's
// finger written in. The music comes as events per hand — when each begins
// (in beats from the start), how long it lasts, and the keys it strikes —
// and comes out in measures of so many beats, a note that crosses a barline
// tied over it, and every gap a rest.

const DIVISIONS = 4; // per quarter note, so a beat divides into sixteenths
// Note values the notation can show, longest first, as beats: the type and whether it is dotted.
const VALUES = [
  [4, "whole", false],
  [3, "half", true],
  [2, "half", false],
  [1.5, "quarter", true],
  [1, "quarter", false],
  [0.75, "eighth", true],
  [0.5, "eighth", false],
  [0.25, "16th", false],
];
const STAFF = { right: 1, left: 2 };
const CLEF = { right: { sign: "G", line: 2 }, left: { sign: "F", line: 4 } };

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ticks = (beats) => Math.round(beats * DIVISIONS);

// A note name as MusicXML has it: the step, how it is altered, its octave.
function pitchXml(note) {
  const match = String(note).match(/^([A-G])([#b]?)(-?\d)$/);
  if (!match) throw new Error(`Not a note: ${note}`);
  const alter = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  return { xml: `<pitch><step>${match[1]}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${match[3]}</octave></pitch>`, accidental: alter === 1 ? "sharp" : alter === -1 ? "flat" : null };
}

// A length in beats as note values the notation can show, longest first.
function values(beats) {
  const out = [];
  let left = ticks(beats);
  while (left > 0) {
    const value = VALUES.find(([length]) => ticks(length) <= left) ?? VALUES.at(-1);
    out.push(value);
    left -= ticks(value[0]);
  }
  return out;
}

function noteXml({ note, finger }, [beats, type, dotted], { chord = false, tieStart = false, tieStop = false, staff }) {
  const pitch = pitchXml(note);
  const ties = `${tieStop ? '<tie type="stop"/>' : ""}${tieStart ? '<tie type="start"/>' : ""}`;
  const tied = `${tieStop ? '<tied type="stop"/>' : ""}${tieStart ? '<tied type="start"/>' : ""}`;
  const fingering = finger ? `<technical><fingering>${finger}</fingering></technical>` : "";
  const notations = tied || fingering ? `<notations>${tied}${fingering}</notations>` : "";
  return `<note>${chord ? "<chord/>" : ""}${pitch.xml}<duration>${ticks(beats)}</duration>${ties}<voice>${staff}</voice><type>${type}</type>${dotted ? "<dot/>" : ""}${pitch.accidental ? `<accidental>${pitch.accidental}</accidental>` : ""}<staff>${staff}</staff>${notations}</note>`;
}

const restXml = ([beats, type, dotted], staff) => `<note><rest/><duration>${ticks(beats)}</duration><voice>${staff}</voice><type>${type}</type>${dotted ? "<dot/>" : ""}<staff>${staff}</staff></note>`;
const wholeRestXml = (beats, staff) => `<note><rest measure="yes"/><duration>${ticks(beats)}</duration><voice>${staff}</voice><staff>${staff}</staff></note>`;

// One hand's staff through one measure: its notes where they fall, tied
// over the barlines, with rests between. `events` are the hand's, in order.
function staffXml(hand, events, from, to) {
  const staff = STAFF[hand];
  const parts = [];
  let at = from;
  for (const event of events) {
    const begins = Math.max(event.time, from);
    const ends = Math.min(event.time + event.duration, to);
    if (ends <= from + 1e-6 || begins >= to - 1e-6) continue;
    for (const value of values(begins - at)) parts.push(restXml(value, staff));
    // A note that began before this measure, or goes on past it, is tied.
    const pieces = values(ends - begins);
    pieces.forEach((value, index) => {
      const tieStop = index > 0 || begins > event.time + 1e-6;
      const tieStart = index < pieces.length - 1 || ends < event.time + event.duration - 1e-6;
      event.notes.forEach((note, which) => parts.push(noteXml(note, value, { chord: which > 0, tieStart, tieStop, staff })));
    });
    at = ends;
  }
  if (!parts.length) return wholeRestXml(to - from, staff);
  for (const value of values(to - at)) parts.push(restXml(value, staff));
  return parts.join("");
}

// The piece as MusicXML. parts: { right: [event], left: [event] }, each
// event { time, duration, notes: [{ note, finger }] } in beats; beatsPerMeasure
// sets the time signature; tempo, if given, is written as the piece's.
export function writeScore({ title = "", tempo = null, beatsPerMeasure = 4, parts }) {
  const hands = ["right", "left"];
  const events = Object.fromEntries(hands.map((hand) => [hand, [...(parts[hand] ?? [])].sort((a, b) => a.time - b.time)]));
  const length = Math.max(0, ...hands.flatMap((hand) => events[hand].map((event) => event.time + event.duration)));
  const count = Math.max(1, Math.ceil(length / beatsPerMeasure - 1e-6));
  const measures = [];
  for (let index = 0; index < count; index += 1) {
    const from = index * beatsPerMeasure;
    const to = from + beatsPerMeasure;
    const attributes =
      index === 0
        ? `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>0</fifths></key><time><beats>${beatsPerMeasure}</beats><beat-type>4</beat-type></time><staves>2</staves>${hands.map((hand) => `<clef number="${STAFF[hand]}"><sign>${CLEF[hand].sign}</sign><line>${CLEF[hand].line}</line></clef>`).join("")}</attributes>${tempo ? `<direction placement="above"><direction-type><words>${escape(`♩ = ${tempo}`)}</words></direction-type><sound tempo="${tempo}"/></direction>` : ""}`
        : "";
    const staves = hands.map((hand) => staffXml(hand, events[hand], from, to));
    measures.push(`<measure number="${index + 1}">${attributes}${staves[0]}<backup><duration>${ticks(beatsPerMeasure)}</duration></backup>${staves[1]}</measure>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
<work><work-title>${escape(title)}</work-title></work>
<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">
${measures.join("\n")}
</part>
</score-partwise>
`;
}
