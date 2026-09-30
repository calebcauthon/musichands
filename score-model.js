import { midiToNote, noteToMidi } from "./hand-model.js";
import { child, children, number, parseXml, text } from "./xml.js";

// Turns MusicXML into a flat timeline the hand renderer can consume: for every
// moment where a hand plays something, which notes it holds and (if the score
// says so) which finger is on each one.

function pitchName(pitchNode) {
  const step = text(pitchNode, "step");
  const alter = number(pitchNode, "alter", 0);
  const octave = number(pitchNode, "octave");
  if (alter === 0) return `${step}${octave}`;
  if (alter === 1) return `${step}#${octave}`;
  if (alter === -1) return `${step}b${octave}`;
  return midiToNote(noteToMidi(`${step}${octave}`) + alter);
}

function scoreFingering(noteNode) {
  const technical = child(child(noteNode, "notations"), "technical");
  const value = text(technical, "fingering", "");
  const match = value.match(/[1-5]/);
  return match ? Number(match[0]) : null;
}

function readPart(partNode) {
  const events = [];
  const measures = [];
  let divisions = 1;
  let beats = 4;
  let beatType = 4;
  let fifths = 0;
  let staffCount = 1;
  const clefs = {}; // staff number → clef sign, as it stands
  let measureStart = 0; // in quarter notes from the beginning of the piece

  children(partNode, "measure").forEach((measureNode, measureIndex) => {
    const attributes = child(measureNode, "attributes");
    if (attributes) {
      divisions = number(attributes, "divisions", divisions);
      const time = child(attributes, "time");
      if (time) {
        beats = number(time, "beats", beats);
        beatType = number(time, "beat-type", beatType);
      }
      const key = child(attributes, "key");
      if (key) fifths = number(key, "fifths", fifths);
      staffCount = number(attributes, "staves", staffCount);
    }
    for (const attributesNode of children(measureNode, "attributes")) {
      for (const clef of children(attributesNode, "clef")) clefs[Number(clef.attrs.number ?? 1)] = text(clef, "sign", "G");
    }

    const measureNumber = measureNode.attrs.number ?? String(measureIndex + 1);
    const measure = {
      index: measureIndex,
      number: measureNumber,
      start: measureStart,
      beats,
      beatType,
      fifths,
      events: [],
    };
    let position = 0; // in divisions from the start of this measure
    let chordStart = 0;
    let maxPosition = 0;
    const played = []; // every pitched note in the measure, before it is given to a hand

    measureNode.children.forEach((node) => {
      if (node.name === "backup") {
        position -= number(node, "duration", 0);
        return;
      }
      if (node.name === "forward") {
        position += number(node, "duration", 0);
        maxPosition = Math.max(maxPosition, position);
        return;
      }
      if (node.name !== "note") return;

      const isChord = Boolean(child(node, "chord"));
      const isGrace = Boolean(child(node, "grace"));
      const duration = number(node, "duration", 0);
      const start = isChord ? chordStart : position;
      if (!isChord && !isGrace) {
        chordStart = position;
        position += duration;
        maxPosition = Math.max(maxPosition, position);
      }
      if (isGrace || child(node, "rest")) return;

      const pitch = child(node, "pitch");
      if (!pitch) return;
      played.push({ node, pitch, start, duration, staff: number(node, "staff", 1) });
    });

    // Which staff belongs to which hand can change from measure to measure
    // when a piece is set on more than two staves.
    const handOf = handsForStaves(staffCount, [...new Set(played.map((entry) => entry.staff))].sort((a, b) => a - b), clefs);
    const byMoment = new Map();
    for (const { node, pitch, start, duration, staff } of played) {
      const hand = handOf(staff);
      const ties = children(node, "tie").map((tie) => tie.attrs.type);
      const key = `${start}:${hand}`;
      let event = byMoment.get(key);
      if (!event) {
        event = {
          measure: measureNumber,
          measureIndex,
          hand,
          offset: start / divisions,
          time: measureStart + start / divisions,
          beat: 1 + (start / divisions) * (beatType / 4),
          duration: 0,
          attack: false,
          notes: [],
        };
        byMoment.set(key, event);
        events.push(event);
        measure.events.push(event);
      }
      const note = pitchName(pitch);
      // A note that only continues a tie is still under the finger, but it is not a new attack.
      if (!ties.includes("stop")) event.attack = true;
      event.duration = Math.max(event.duration, duration / divisions);
      if (!event.notes.some((entry) => entry.midi === noteToMidi(note))) {
        event.notes.push({
          note,
          midi: noteToMidi(note),
          finger: scoreFingering(node),
          held: ties.includes("stop"), // continues a note already sounding, so it is not played again
          tied: ties.includes("start"), // carries on into the next note of the same pitch
          duration: duration / divisions,
        });
      }
    }

    // A pickup measure is only as long as the notes in it.
    const pickup = measureNode.attrs.implicit === "yes" && maxPosition > 0;
    const measureLength = pickup ? maxPosition / divisions : Math.max(maxPosition / divisions, (beats * 4) / beatType);
    measure.length = measureLength;
    measures.push(measure);
    measureStart += measureLength;
  });

  const sortEvents = (list) => list.sort((a, b) => a.time - b.time || (a.hand === "right" ? -1 : 1));
  sortEvents(events);
  sustainTies(events);
  measures.forEach((measure) => {
    sortEvents(measure.events);
    measure.events.forEach((event) => event.notes.sort((a, b) => a.midi - b.midi));
  });
  return { measures, events };
}

// Gives each staff of a measure to a hand. On a grand staff the top staff is
// the right hand. A piece set on more staves is read the way it is played:
// the staves in use are shared out top half to the right hand, bottom half to
// the left, and a lone or odd staff goes by its clef.
function handsForStaves(staffCount, active, clefs) {
  if (staffCount <= 2) return (staff) => (staff >= 2 ? "left" : "right");
  const byClef = (staff) => (clefs[staff] === "F" ? "left" : "right");
  if (active.length <= 1) return byClef;
  const upper = new Set(active.slice(0, Math.floor(active.length / 2)));
  const lower = new Set(active.slice(Math.ceil(active.length / 2)));
  return (staff) => (upper.has(staff) ? "right" : lower.has(staff) ? "left" : byClef(staff));
}

// A tied note sounds for its own length and that of every note it is tied
// into, so give each note the whole time it rings.
function sustainTies(events) {
  for (const hand of ["right", "left"]) {
    const own = events.filter((event) => event.hand === hand);
    own.forEach((event, index) => {
      for (const note of event.notes) {
        note.sustain = note.duration;
        let end = event.time + note.duration;
        let link = note;
        for (let next = index + 1; link.tied && next < own.length; next += 1) {
          const later = own[next];
          if (later.time > end + 1e-6) break;
          if (Math.abs(later.time - end) > 1e-6) continue;
          const continued = later.notes.find((entry) => entry.midi === note.midi && entry.held);
          if (!continued) break;
          note.sustain += continued.duration;
          end += continued.duration;
          link = continued;
        }
      }
    });
  }
}

// The first tempo the score states, in quarter notes a minute.
function readTempo(score) {
  for (const part of children(score, "part")) {
    for (const measure of children(part, "measure")) {
      for (const node of measure.children) {
        const sound = node.name === "sound" ? node : node.name === "direction" ? child(node, "sound") : null;
        const tempo = Number(sound?.attrs.tempo);
        if (tempo > 0) return tempo;
      }
    }
  }
  return null;
}

export function parseScore(xmlText) {
  const document = parseXml(xmlText);
  const score = child(document, "score-partwise");
  if (!score) throw new Error("Only score-partwise MusicXML is supported");

  const partList = children(child(score, "part-list"), "score-part");
  const parts = children(score, "part").map((partNode) => {
    const meta = partList.find((entry) => entry.attrs.id === partNode.attrs.id);
    return { id: partNode.attrs.id, name: text(meta, "part-name", partNode.attrs.id), ...readPart(partNode) };
  });
  const primary = parts.find((part) => /piano|keyboard/i.test(part.name)) ?? parts[0];

  return {
    title: text(child(score, "work"), "work-title", "") || text(score, "movement-title", "Untitled"),
    tempo: readTempo(score),
    parts,
    measures: primary?.measures ?? [],
    events: primary?.events ?? [],
  };
}
