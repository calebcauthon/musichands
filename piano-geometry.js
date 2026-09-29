// A real piano keyboard in metres. X runs up the keyboard (x = 0 is the line
// between E4 and F4), Y is up with the white key tops at y = 0, and the keys
// run away from the player toward -Z with their front edge at z = 0.
import { isBlackNote, midiToNote } from "./hand-model.js";

export const KEYBOARD = {
  lowestMidi: 21,
  highestMidi: 108,
  whiteWidth: 0.0235,
  whiteLength: 0.15,
  whiteDepth: 0.022,
  keyGap: 0.0007,
  blackWidth: 0.0132,
  blackTopWidth: 0.0098,
  blackLength: 0.095,
  blackRise: 0.0115,
  dip: 0.0095, // how far the front of a key travels when pressed
  pivot: 0.235, // distance from the front edge back to the balance point
};

// Black keys are not centred on the line between their white neighbours.
const BLACK_OFFSET = { 1: -0.0027, 3: 0.0027, 6: -0.0036, 8: 0, 10: 0.0036 };
const WHITES_BELOW_ORIGIN = 26; // A0 … E4

function whiteIndex(midi) {
  let count = 0;
  for (let value = KEYBOARD.lowestMidi; value < midi; value += 1) {
    if (!isBlackNote(midiToNote(value))) count += 1;
  }
  return count;
}

const smoothstep = (edge0, edge1, value) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

function buildKeys() {
  const keys = new Map();
  for (let midi = KEYBOARD.lowestMidi; midi <= KEYBOARD.highestMidi; midi += 1) {
    const note = midiToNote(midi);
    const black = isBlackNote(note);
    if (black) {
      const boundary = (whiteIndex(midi) - WHITES_BELOW_ORIGIN) * KEYBOARD.whiteWidth;
      const x = boundary + BLACK_OFFSET[midi % 12];
      keys.set(midi, {
        midi,
        note,
        black,
        x,
        xMin: x - KEYBOARD.blackWidth / 2,
        xMax: x + KEYBOARD.blackWidth / 2,
        top: KEYBOARD.blackRise,
        zFront: -(KEYBOARD.whiteLength - KEYBOARD.blackLength),
        zBack: -KEYBOARD.whiteLength,
      });
    } else {
      const xMin = (whiteIndex(midi) - WHITES_BELOW_ORIGIN) * KEYBOARD.whiteWidth;
      keys.set(midi, {
        midi,
        note,
        black,
        x: xMin + KEYBOARD.whiteWidth / 2,
        xMin,
        xMax: xMin + KEYBOARD.whiteWidth,
        top: 0,
        zFront: 0,
        zBack: -KEYBOARD.whiteLength,
      });
    }
  }
  // Behind the black keys' front edge a white key only shows a narrow strip.
  for (const key of keys.values()) {
    if (key.black) continue;
    const below = keys.get(key.midi - 1);
    const above = keys.get(key.midi + 1);
    key.stripMin = below?.black ? below.xMax : key.xMin;
    key.stripMax = above?.black ? above.xMin : key.xMax;
  }
  return keys;
}

export const KEYS = buildKeys();
export const BLACK_KEYS = [...KEYS.values()].filter((key) => key.black);
export const BLACK_FRONT = -(KEYBOARD.whiteLength - KEYBOARD.blackLength);

export function keyFor(midi) {
  const key = KEYS.get(Number(midi));
  if (!key) throw new Error(`No piano key for MIDI note ${midi}`);
  return key;
}

// Where along X a fingertip should sit on a key, given how far in it is.
export function keyCenterAt(key, z) {
  if (key.black) return key.x;
  const strip = (key.stripMin + key.stripMax) / 2;
  const inBack = smoothstep(BLACK_FRONT + 0.012, BLACK_FRONT - 0.004, z);
  return key.x + (strip - key.x) * inBack;
}

// How far a key's surface has dropped at depth z when pressed by `amount` (0–1).
export function keyDipAt(z, amount) {
  return KEYBOARD.dip * amount * Math.max(0, (KEYBOARD.pivot + z) / KEYBOARD.pivot);
}

// Height of the keyboard surface under a point, with soft shoulders around the
// black keys so a solver can feel its way over them.
export function surfaceHeight(x, z) {
  if (z > BLACK_FRONT + 0.004 || z < -KEYBOARD.whiteLength - 0.02) return 0;
  const depth = smoothstep(BLACK_FRONT + 0.004, BLACK_FRONT, z);
  let height = 0;
  const half = KEYBOARD.blackWidth / 2;
  for (const key of BLACK_KEYS) {
    const distance = Math.abs(x - key.x);
    if (distance > half + 0.004) continue;
    height = Math.max(height, 1 - smoothstep(half, half + 0.004, distance));
  }
  return KEYBOARD.blackRise * height * depth;
}
