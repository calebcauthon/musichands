// The player: a bench, a body seated on it, and an arm from each shoulder.
//
// The seat never moves along the bench. hand-rig.js decides where a hand goes
// on the keys; here its wrist is joined back to a shoulder by an upper arm and
// a forearm of fixed length, so reaching along the keyboard swings the elbow
// and turns the forearm the way it does on a real player. The torso leans from
// the hips only when a wrist is further away than the arm can reach.
import { mat4, vec3 } from "./rig-math.js";

const DEG = Math.PI / 180;
const SIDES = ["left", "right"];
const SIGN = { left: -1, right: 1 };

// Metres, in the keyboard's frame (see piano-geometry.js): the player faces
// the middle of the keyboard from the +z side, and the white key tops are y = 0.
export const BODY = {
  floor: -0.735,
  bench: { top: -0.245, width: 0.66, depth: 0.36, z: 0.54 },
  hip: [0, -0.15, 0.47], // the point the torso leans about
  spine: 0.49, // from the hips up to the line between the shoulders
  shoulder: 0.185, // from the spine out to each shoulder joint
  slouch: 6 * DEG, // how far forward the torso tips with everything in reach
  upperArm: 0.3,
  forearm: 0.265,
  reach: 0.94, // the share of a straight arm a player uses before leaning instead
  lean: { side: 26 * DEG, forward: [-6 * DEG, 32 * DEG] },
  // Where a hand waits on the thigh when it has nothing to play: the wrist of
  // a right hand, and how the hand is turned (degrees, as in hand-rig.js).
  lap: { wrist: [0.112, -0.062, 0.3], yaw: 24, pitch: -7, roll: -6 },
};
// Which way the elbow hangs from the line between shoulder and wrist: down,
// a little out from the body and a little back. From there it can swing about
// that line, out and up (positive) or in against the ribs.
const ELBOW = { out: 0.45, back: 0.15 };
export const ELBOW_SWING = [-12 * DEG, 60 * DEG];
export const UPRIGHT = { side: 0, forward: 0 };

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Takes points on the torso (measured from the hips, y up the spine) to where
// they are with the torso leaning. `side` leans toward the player's right,
// `forward` toward the keys.
export function torsoMatrix(lean = UPRIGHT) {
  const tipped = mat4.multiply(mat4.rotation([1, 0, 0], -(BODY.slouch + lean.forward)), mat4.rotation([0, 0, 1], -lean.side));
  tipped[12] = BODY.hip[0];
  tipped[13] = BODY.hip[1];
  tipped[14] = BODY.hip[2];
  return tipped;
}

export function shoulderPoint(side, lean = UPRIGHT) {
  return mat4.transformPoint(torsoMatrix(lean), [SIGN[side] * BODY.shoulder, BODY.spine, 0]);
}

// The least lean that brings every wrist within reach of its shoulder.
// wrists: { left, right }, each a point or missing.
export function leanFor(wrists) {
  const lean = { side: 0, forward: 0 };
  const limit = (BODY.upperArm + BODY.forearm) * BODY.reach;
  const nudge = 1e-4;
  for (let pass = 0; pass < 16; pass += 1) {
    let settled = true;
    for (const side of SIDES) {
      if (!wrists[side]) continue;
      const shoulder = shoulderPoint(side, lean);
      const gap = vec3.sub(wrists[side], shoulder);
      const excess = vec3.length(gap) - limit;
      if (excess <= 1e-5) continue;
      settled = false;
      // How much closer each kind of lean brings this shoulder to its wrist.
      const toward = vec3.normalize(gap);
      const gain = (leaned) => vec3.dot(toward, vec3.sub(shoulderPoint(side, leaned), shoulder)) / nudge;
      const bySide = gain({ side: lean.side + nudge, forward: lean.forward });
      const byForward = gain({ side: lean.side, forward: lean.forward + nudge });
      const step = excess / (bySide * bySide + byForward * byForward || 1);
      lean.side = clamp(lean.side + bySide * step, -BODY.lean.side, BODY.lean.side);
      lean.forward = clamp(lean.forward + byForward * step, BODY.lean.forward[0], BODY.lean.forward[1]);
    }
    if (settled) break;
  }
  return lean;
}

// Where the elbow sits between a shoulder and a wrist, swung `swing` radians
// from where it would hang.
export function elbowPoint(side, shoulder, wrist, swing = 0) {
  if (side === "left") {
    // A left arm is a right arm in a mirror.
    const [x, y, z] = elbowPoint("right", [-shoulder[0], shoulder[1], shoulder[2]], [-wrist[0], wrist[1], wrist[2]], swing);
    return [-x, y, z];
  }
  const { upperArm, forearm } = BODY;
  const gap = vec3.sub(wrist, shoulder);
  const distance = clamp(vec3.length(gap), Math.abs(upperArm - forearm) + 1e-4, (upperArm + forearm) * 0.9995);
  const toward = vec3.normalize(gap);
  const along = (upperArm * upperArm - forearm * forearm + distance * distance) / (2 * distance);
  const away = Math.sqrt(Math.max(0, upperArm * upperArm - along * along));
  const hang = [ELBOW.out, -1, ELBOW.back];
  const down = vec3.normalize(vec3.sub(hang, vec3.scale(toward, vec3.dot(hang, toward))));
  const out = vec3.cross(down, toward);
  const across = vec3.add(vec3.scale(down, Math.cos(swing)), vec3.scale(out, Math.sin(swing)));
  return vec3.add(vec3.add(shoulder, vec3.scale(toward, along)), vec3.scale(across, away));
}

// The whole seated player for a pair of wrists: how the torso leans, and each
// arm's shoulder, elbow and wrist. `swings` is how far each elbow is swung out.
export function seatPlayer(wrists, swings = {}) {
  const lean = leanFor(wrists);
  const arms = {};
  for (const side of SIDES) {
    if (!wrists[side]) continue;
    const shoulder = shoulderPoint(side, lean);
    arms[side] = { shoulder, elbow: elbowPoint(side, shoulder, wrists[side], swings[side] ?? 0), wrist: wrists[side] };
  }
  return { lean, arms };
}

// The direction a forearm arrives from, elbow to wrist, for a hand whose wrist
// is at `wrist` and whose elbow is swung out by `swing`. The pose solver asks
// this many times over, so an out-of-reach shoulder simply comes straight
// toward the wrist instead of solving the lean.
export function forearmDirection(side, wrist, swing = 0) {
  let shoulder = shoulderPoint(side);
  const gap = vec3.sub(wrist, shoulder);
  const excess = vec3.length(gap) - (BODY.upperArm + BODY.forearm) * BODY.reach;
  if (excess > 0) shoulder = vec3.add(shoulder, vec3.scale(vec3.normalize(gap), excess));
  return vec3.normalize(vec3.sub(wrist, elbowPoint(side, shoulder, wrist, swing)));
}
