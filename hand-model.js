const NOTE_PATTERN = /^([A-Ga-g])([#b]?)(-?\d)$/;
const NATURAL_PITCH_CLASSES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_TO_SHARP = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };

export function normalizeNote(note) {
  const match = String(note).trim().match(NOTE_PATTERN);
  if (!match) throw new Error(`Invalid note: ${note}`);

  const letter = match[1].toUpperCase();
  const accidental = match[2];
  const octave = Number(match[3]);
  let pitchClass = NATURAL_PITCH_CLASSES[letter];
  if (accidental === "#") pitchClass += 1;
  if (accidental === "b") pitchClass -= 1;

  let normalizedOctave = octave;
  if (pitchClass < 0) {
    pitchClass += 12;
    normalizedOctave -= 1;
  }
  if (pitchClass > 11) {
    pitchClass -= 12;
    normalizedOctave += 1;
  }

  return `${SHARP_NAMES[pitchClass]}${normalizedOctave}`;
}

export function noteToMidi(note) {
  const normalized = normalizeNote(note);
  const match = normalized.match(NOTE_PATTERN);
  const pitchName = `${match[1]}${match[2]}`;
  const octave = Number(match[3]);
  const canonicalPitch = FLAT_TO_SHARP[pitchName] ?? pitchName;
  return (octave + 1) * 12 + SHARP_NAMES.indexOf(canonicalPitch);
}

export function midiToNote(midi) {
  const value = Math.max(0, Math.min(127, Number(midi)));
  return `${SHARP_NAMES[value % 12]}${Math.floor(value / 12) - 1}`;
}

export function isBlackNote(note) {
  return normalizeNote(note).includes("#");
}

export function noteOptions(minMidi = 36, maxMidi = 84) {
  const notes = [];
  for (let midi = minMidi; midi <= maxMidi; midi += 1) notes.push(midiToNote(midi));
  return notes;
}

// White keys to show around the assigned notes. The palm and any idle fingers
// spread out on the thumb side of the lowest assigned finger (for a right hand)
// or the highest one (for a left hand), so that side gets more room when the
// thumb itself is not placed.
export function getKeyboardWindow(fingers, minimumWhiteKeys = 12, hand = "right") {
  const midis = fingers.map((finger) => noteToMidi(finger.note));
  const low = Math.min(...midis);
  const high = Math.max(...midis);
  const lowFinger = fingers.find((finger) => noteToMidi(finger.note) === low)?.finger ?? 1;
  const highFinger = fingers.find((finger) => noteToMidi(finger.note) === high)?.finger ?? 1;
  const palmKeys = (finger) => Math.round((finger - 1) * 1.3);
  const lowMargin = 2 + (hand === "right" ? palmKeys(lowFinger) : 0);
  const highMargin = 3 + (hand === "left" ? palmKeys(highFinger) : 0);

  let start = low;
  while (isBlackNote(midiToNote(start))) start -= 1;
  for (let count = 0; count < lowMargin; start -= 1) {
    if (!isBlackNote(midiToNote(start))) count += 1;
  }
  start += 1;

  let end = high;
  for (let count = 0; count < highMargin; end += 1) {
    if (!isBlackNote(midiToNote(end))) count += 1;
  }

  const whiteNotes = [];
  let midi = start;
  while (whiteNotes.length < minimumWhiteKeys || midi < end) {
    const note = midiToNote(midi);
    if (!isBlackNote(note)) whiteNotes.push({ note, midi });
    midi += 1;
  }

  return whiteNotes;
}

export function describePosition(hand, fingers) {
  const thumb = fingers.find((finger) => finger.finger === 1)?.note ?? "—";
  const pinky = fingers.find((finger) => finger.finger === 5)?.note ?? "—";
  return `${hand === "right" ? "Thumb" : "Thumb"} on ${thumb} · pinky on ${pinky}`;
}
