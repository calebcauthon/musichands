import { noteToMidi } from "./hand-model.js";

// Works out which finger plays each note by first grouping a hand's notes into
// "positions" (stretches that fit under one hand without moving), then choosing
// fingers for the whole position at once so they stay consistent across it.
//
// Finger numbers come, in priority order, from:
//   1. overrides keyed by "measure:beat": the player's own corrections, or a sidecar file,
//   2. fingerings written in the score,
//   3. a spread heuristic across the keys the position uses.
// Every event and position records where its fingering came from so the page can
// be honest about what is authored and what is a guess.

const THUMB = 1;
const PINKY = 5;
const MAX_KEYS = 5;
const MAX_SPAN = 12; // semitones a relaxed hand covers thumb to pinky

function spreadFingers(midis) {
  // Fingers for an ascending set of keys with the thumb on the bottom one.
  // Small intervals take neighboring fingers; wider ones skip a finger.
  const fingers = [THUMB];
  for (let index = 1; index < midis.length; index += 1) {
    const interval = midis[index] - midis[index - 1];
    fingers.push(fingers[index - 1] + Math.max(1, Math.round(interval / 2)));
  }
  if (fingers[fingers.length - 1] <= PINKY) return fingers;

  // The hand cannot reach that way, so spread the fingers proportionally instead.
  const low = midis[0];
  const span = midis[midis.length - 1] - low;
  const spread = midis.map((midi) => THUMB + Math.round(((midi - low) / span) * (PINKY - THUMB)));
  for (let index = 1; index < spread.length; index += 1) {
    if (spread[index] <= spread[index - 1]) spread[index] = spread[index - 1] + 1;
  }
  for (let index = spread.length - 2; index >= 0; index -= 1) {
    if (spread[index] >= spread[index + 1]) spread[index] = spread[index + 1] - 1;
  }
  return spread.map((finger) => Math.min(PINKY, Math.max(THUMB, finger)));
}

function fillAroundFixed(midis, fixed) {
  // Like spreadFingers, but honors fingers that were already decided (fixed is a
  // Map of midi → finger) and keeps the unfixed ones in ascending order between them.
  const fingers = midis.map((midi) => fixed.get(midi) ?? null);
  let previous = 0;
  for (let index = 0; index < midis.length; index += 1) {
    if (fingers[index]) {
      previous = fingers[index];
      continue;
    }
    let nextFixedIndex = midis.findIndex((midi, candidate) => candidate > index && fingers[candidate]);
    const ceiling = nextFixedIndex === -1 ? PINKY : fingers[nextFixedIndex] - (nextFixedIndex - index);
    const interval = index === 0 ? 0 : midis[index] - midis[index - 1];
    const natural = previous === 0 ? THUMB : previous + Math.max(1, Math.round(interval / 2));
    fingers[index] = Math.max(previous + 1, Math.min(ceiling, natural, PINKY));
    previous = fingers[index];
  }
  return fingers;
}

// Fingers for one hand over a set of keys. The left hand is a mirror image (thumb
// on the highest key), so flip the pitches, solve for a right hand, and flip back.
export function heuristicFingering(notes, hand, fixed = new Map()) {
  const sign = hand === "left" ? -1 : 1;
  const ordered = [...notes].sort((a, b) => sign * (a.midi - b.midi));
  const midis = ordered.map((note) => sign * note.midi);
  const mirroredFixed = new Map([...fixed.entries()].map(([midi, finger]) => [sign * midi, finger]));
  const fingers = fixed.size ? fillAroundFixed(midis, mirroredFixed) : spreadFingers(midis);
  const byMidi = new Map(ordered.map((note, index) => [note.midi, Math.min(PINKY, Math.max(THUMB, fingers[index]))]));
  return notes.map((note) => ({ ...note, finger: byMidi.get(note.midi) }));
}

function overrideFor(overrides, event) {
  return overrides?.[`${event.measure}:${event.beat}`]?.[event.hand] ?? null;
}

// Fingers the score or the sidecar file already decided, per note of the event.
function authoredFingers(event, overrides) {
  const override = overrideFor(overrides, event);
  return event.notes.map((note) => {
    // A correction is deliberate, so it beats what the score says.
    const value = override?.[note.note] ?? override?.[noteToMidi(note.note)];
    if (value >= 1 && value <= 5) return { finger: Number(value), source: "override" };
    if (note.finger) return { finger: note.finger, source: "score" };
    return { finger: null, source: "heuristic" };
  });
}

// True when a set of fingered notes is something one hand can actually do: every
// finger in range, no finger on two keys, and fingers in pitch order for the hand.
function playable(fingered, hand) {
  const sign = hand === "left" ? -1 : 1;
  const ordered = [...fingered].sort((a, b) => sign * (a.midi - b.midi));
  return ordered.every((note, index) => {
    if (!(note.finger >= THUMB && note.finger <= PINKY)) return false;
    return index === 0 || note.finger > ordered[index - 1].finger;
  });
}

function fitsPosition(position, notes, authored) {
  const keys = new Set(position.keys);
  notes.forEach((note) => keys.add(note.midi));
  if (keys.size > MAX_KEYS) return false;
  const midis = [...keys];
  if (Math.max(...midis) - Math.min(...midis) > MAX_SPAN) return false;

  // Authored fingers must not contradict fingers already fixed in this position,
  // and the whole position must still be playable once they are added.
  const fixed = new Map(position.fixed);
  for (let index = 0; index < notes.length; index += 1) {
    const finger = authored[index].finger;
    if (!finger) continue;
    const midi = notes[index].midi;
    const existing = fixed.get(midi);
    if (existing && existing !== finger) return false;
    if ([...fixed.entries()].some(([other, used]) => used === finger && other !== midi)) return false;
    fixed.set(midi, finger);
  }
  return playable(heuristicFingering(midis.map((midi) => ({ midi })), position.hand, fixed), position.hand);
}

function newPosition(hand, event) {
  return {
    hand,
    keys: new Set(),
    fixed: new Map(),
    events: [],
    sources: new Set(),
    startTime: event.time,
    endTime: event.time,
    startMeasure: event.measure,
    endMeasure: event.measure,
    startBeat: event.beat,
  };
}

export function assignFingering(events, { overrides = {} } = {}) {
  const positions = { right: [], left: [] };
  const current = { right: null, left: null };
  const placements = new Map(); // event → its position

  events.forEach((event) => {
    const authored = authoredFingers(event, overrides);
    const hand = event.hand;
    if (!current[hand] || !fitsPosition(current[hand], event.notes, authored)) {
      current[hand] = newPosition(hand, event);
      positions[hand].push(current[hand]);
    }
    const position = current[hand];
    event.notes.forEach((note, index) => {
      position.keys.add(note.midi);
      if (authored[index].finger) position.fixed.set(note.midi, authored[index].finger);
      position.sources.add(authored[index].source);
    });
    position.events.push(event);
    position.endTime = Math.max(position.endTime, event.time + event.duration);
    position.endMeasure = event.measure;
    placements.set(event, position);
  });

  const finished = {};
  ["right", "left"].forEach((hand) => {
    finished[hand] = positions[hand].map((position) => {
      const notes = [...position.keys].map((midi) => ({ midi }));
      const fingered = heuristicFingering(notes, hand, position.fixed);
      position.fingerByMidi = new Map(fingered.map((note) => [note.midi, note.finger]));
      const fingers = position.events
        .flatMap((event) => event.notes)
        .reduce((map, note) => map.set(position.fingerByMidi.get(note.midi), note.note), new Map());
      return {
        hand,
        startTime: position.startTime,
        endTime: position.endTime,
        startMeasure: position.startMeasure,
        endMeasure: position.endMeasure,
        startBeat: position.startBeat,
        events: position.events,
        sources: [...position.sources],
        fingers: [...fingers.entries()].sort((a, b) => a[0] - b[0]).map(([finger, note]) => ({ finger, note })),
      };
    });
  });

  const fingeredEvents = events.map((event) => {
    const position = placements.get(event);
    const authored = authoredFingers(event, overrides);
    const notes = event.notes.map((note) => ({ ...note, finger: position.fingerByMidi.get(note.midi) }));
    const sources = new Set(authored.map((entry) => entry.source));
    const fingeringSource = sources.has("heuristic") ? "heuristic" : sources.has("override") ? "override" : "score";
    return { ...event, notes, fingeringSource };
  });

  return { events: fingeredEvents, positions: finished };
}
