// The hand as a rigid skeleton, and a solver that places it on the piano.
//
// Bones never change length: a pose is only the hand's position and turn plus
// joint angles, and everything drawn comes from running those through the
// skeleton. The solver finds the pose whose fingertips rest on their keys
// while staying as close as it can to a relaxed playing shape.
import { FINGER_JOINTS } from "./glb-skeleton.js";
import { BLACK_FRONT, KEYBOARD, keyCenterAt, keyDipAt, surfaceHeight } from "./piano-geometry.js";
import { mat4, vec3 } from "./rig-math.js";

const DEG = Math.PI / 180;
const FINGERS = [1, 2, 3, 4, 5];
const LONG_FINGERS = [2, 3, 4, 5];

// Fingertips are modelled as a ball at the end of the last bone: `ahead` is
// how far past the tip joint its centre sits, `radius` how thick the finger
// is there. Angles are in degrees from the model's flat rest pose. `abd` is a
// sideways swing at the knuckle, positive toward the pinky.
const FINGER_MODEL = {
  1: {
    radius: 0.0088,
    ahead: 0.0012,
    rest: { swing: 8, drop: 14, flex: 34 },
    limits: { swing: [-38, 34], drop: [-12, 46], flex: [-6, 62] },
    depth: { white: -0.02, black: -0.075 },
  },
  2: {
    radius: 0.0068,
    ahead: 0.0044,
    rest: { abd: 2, mcp: 27, pip: 27 },
    limits: { abd: [-24, 12], mcp: [-12, 78], pip: [2, 96] },
    depth: { white: -0.034, black: -0.082 },
  },
  3: {
    radius: 0.007,
    ahead: 0.0055,
    rest: { abd: 2, mcp: 28, pip: 28 },
    limits: { abd: [-13, 13], mcp: [-12, 80], pip: [2, 98] },
    depth: { white: -0.04, black: -0.088 },
  },
  4: {
    radius: 0.0067,
    ahead: 0.0049,
    rest: { abd: -3, mcp: 27, pip: 27 },
    limits: { abd: [-14, 12], mcp: [-10, 78], pip: [2, 96] },
    depth: { white: -0.036, black: -0.084 },
  },
  5: {
    radius: 0.0058,
    ahead: 0.004,
    rest: { abd: -4, mcp: 22, pip: 20 },
    limits: { abd: [-16, 24], mcp: [-10, 74], pip: [2, 92] },
    depth: { white: -0.026, black: -0.076 },
  },
};
const DIP_FOLLOWS_PIP = 0.55; // the last joint curls with the middle one
const THUMB_MCP_SHARE = 0.45; // how much of the thumb's flex its knuckle takes
const HAND_REST = { yaw: 0, pitch: 4, roll: 0 };
const HAND_LIMITS = { yaw: [-32, 32], pitch: [-14, 30], roll: [-16, 16] };
const HOVER = 0.009; // how far idle fingertips float above the keys
const LIFT = 0.011; // how far a finger rises before it strikes

// Layout of the pose vector.
const HAND_VARS = ["x", "y", "z", "yaw", "pitch", "roll"];
const FINGER_VARS = { 1: ["swing", "drop", "flex"], 2: ["abd", "mcp", "pip"], 3: ["abd", "mcp", "pip"], 4: ["abd", "mcp", "pip"], 5: ["abd", "mcp", "pip"] };
const OFFSET = { 1: 6, 2: 9, 3: 12, 4: 15, 5: 18 };
export const POSE_SIZE = 21;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const hinge = (value) => (value > 0 ? value : 0);

export function createRig(skeleton) {
  const rest = skeleton.rest;
  const fingers = {};
  for (const finger of FINGERS) {
    const names = FINGER_JOINTS[finger];
    const joints = names.map((name) => rest[name]);
    const tip = joints[joints.length - 1];
    const forward = vec3.scale(mat4.axisZ(tip), -1);
    const model = FINGER_MODEL[finger];
    const entry = {
      finger,
      names,
      joints,
      positions: joints.map(mat4.position),
      ball: vec3.add(mat4.position(tip), vec3.scale(forward, model.ahead)),
      radius: model.radius,
    };
    if (finger === 1) {
      const direction = vec3.normalize(vec3.sub(entry.positions[1], entry.positions[0]));
      let dropAxis = vec3.normalize(vec3.cross([0, 1, 0], direction));
      // Positive drop must lower the thumb toward the keys.
      const probe = mat4.transformPoint(mat4.rotationAbout(entry.positions[0], dropAxis, 0.1), entry.ball);
      if (probe[1] > entry.ball[1]) dropAxis = vec3.scale(dropAxis, -1);
      entry.axes = { swing: [0, 1, 0], drop: dropAxis, mcp: mat4.axisX(joints[1]), ip: mat4.axisX(joints[2]) };
    } else {
      entry.axes = { abd: mat4.axisY(joints[1]), mcp: mat4.axisX(joints[1]), pip: mat4.axisX(joints[2]), dip: mat4.axisX(joints[3]) };
    }
    fingers[finger] = entry;
  }
  return { rest, fingers, wrist: skeleton.wrist, wristInverse: skeleton.wristInverse };
}

function handMatrix(pose, scale) {
  const turn = mat4.multiply(
    mat4.rotation([0, 1, 0], pose[3]),
    mat4.multiply(mat4.rotation([1, 0, 0], pose[4]), mat4.rotation([0, 0, 1], pose[5])),
  );
  const matrix = mat4.multiply(turn, mat4.scaling([scale, scale, scale]));
  matrix[12] = pose[0];
  matrix[13] = pose[1];
  matrix[14] = pose[2];
  return matrix;
}

// How each bone of one finger has moved from rest, in wrist space.
function fingerDeltas(rig, finger, pose) {
  const entry = rig.fingers[finger];
  const offset = OFFSET[finger];
  const [p0, p1, p2, p3] = entry.positions;
  if (finger === 1) {
    const swing = pose[offset];
    const drop = pose[offset + 1];
    const flex = pose[offset + 2];
    const base = mat4.multiply(
      mat4.rotationAbout(p0, entry.axes.swing, swing),
      mat4.rotationAbout(p0, entry.axes.drop, drop),
    );
    const knuckle = mat4.multiply(base, mat4.rotationAbout(p1, entry.axes.mcp, -flex * THUMB_MCP_SHARE));
    const last = mat4.multiply(knuckle, mat4.rotationAbout(p2, entry.axes.ip, -flex));
    return [base, knuckle, last, last];
  }
  const abd = pose[offset];
  const mcp = pose[offset + 1];
  const pip = pose[offset + 2];
  const knuckle = mat4.multiply(
    mat4.rotationAbout(p1, entry.axes.abd, -abd),
    mat4.rotationAbout(p1, entry.axes.mcp, -mcp),
  );
  const middle = mat4.multiply(knuckle, mat4.rotationAbout(p2, entry.axes.pip, -pip));
  const last = mat4.multiply(middle, mat4.rotationAbout(p3, entry.axes.dip, -pip * DIP_FOLLOWS_PIP));
  return [mat4.identity(), knuckle, middle, last, last];
}

// World positions of the points the solver cares about on one finger.
function fingerPoints(rig, finger, pose, hand) {
  const entry = rig.fingers[finger];
  const deltas = fingerDeltas(rig, finger, pose);
  const last = deltas[deltas.length - 1];
  const world = (delta, point) => mat4.transformPoint(hand, mat4.transformPoint(delta, point));
  const ball = world(last, entry.ball);
  if (finger === 1) {
    return { ball, joints: [world(deltas[0], entry.positions[1]), world(deltas[1], entry.positions[2])] };
  }
  return { ball, joints: [world(deltas[1], entry.positions[2]), world(deltas[2], entry.positions[3])] };
}

// Every joint's posed matrix in wrist space, plus the hand's world matrix.
export function poseMatrices(rig, pose, scale = 1) {
  const joints = { wrist: mat4.identity() };
  for (const finger of FINGERS) {
    const entry = rig.fingers[finger];
    const deltas = fingerDeltas(rig, finger, pose);
    entry.names.forEach((name, index) => {
      joints[name] = mat4.multiply(deltas[index], entry.joints[index]);
    });
  }
  const hand = handMatrix(pose, scale);
  const balls = {};
  // How far up the keyboard each finger reaches: a curled finger's middle
  // joint can sit further in than its tip.
  const reach = {};
  for (const finger of FINGERS) {
    const points = fingerPoints(rig, finger, pose, hand);
    balls[finger] = points.ball;
    reach[finger] = Math.min(points.ball[2], ...points.joints.map((joint) => joint[2])) - rig.fingers[finger].radius * scale;
  }
  return { hand, joints, balls, reach };
}

export function restPose() {
  const pose = new Array(POSE_SIZE).fill(0);
  pose[3] = HAND_REST.yaw * DEG;
  pose[4] = HAND_REST.pitch * DEG;
  pose[5] = HAND_REST.roll * DEG;
  for (const finger of FINGERS) {
    FINGER_VARS[finger].forEach((name, index) => {
      pose[OFFSET[finger] + index] = FINGER_MODEL[finger].rest[name] * DEG;
    });
  }
  return pose;
}

function bounds() {
  const lower = new Array(POSE_SIZE).fill(-Infinity);
  const upper = new Array(POSE_SIZE).fill(Infinity);
  ["yaw", "pitch", "roll"].forEach((name, index) => {
    lower[3 + index] = HAND_LIMITS[name][0] * DEG;
    upper[3 + index] = HAND_LIMITS[name][1] * DEG;
  });
  for (const finger of FINGERS) {
    FINGER_VARS[finger].forEach((name, index) => {
      lower[OFFSET[finger] + index] = FINGER_MODEL[finger].limits[name][0] * DEG;
      upper[OFFSET[finger] + index] = FINGER_MODEL[finger].limits[name][1] * DEG;
    });
  }
  return { lower, upper };
}

function solveLinear(matrix, vector) {
  const size = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-14) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = column + 1; row < size; row += 1) {
      const factor = a[row][column] / a[column][column];
      if (factor === 0) continue;
      for (let k = column; k <= size; k += 1) a[row][k] -= factor * a[column][k];
    }
  }
  const solution = new Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = a[row][size];
    for (let k = row + 1; k < size; k += 1) sum -= a[row][k] * solution[k];
    solution[row] = sum / a[row][row];
  }
  return solution;
}

// Bounded Levenberg–Marquardt over the variables listed in `free`.
function minimize(residuals, start, { lower, upper, free, iterations = 60 }) {
  let x = start.slice();
  let r = residuals(x);
  let cost = r.reduce((total, value) => total + value * value, 0);
  let damping = 1e-2;
  const n = free.length;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const columns = free.map((index) => {
      const step = 1e-6;
      const saved = x[index];
      x[index] = saved + step;
      const moved = residuals(x);
      x[index] = saved;
      return moved.map((value, row) => (value - r[row]) / step);
    });
    const normal = Array.from({ length: n }, () => new Array(n).fill(0));
    const gradient = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let row = 0; row < r.length; row += 1) gradient[i] += columns[i][row] * r[row];
      for (let j = i; j < n; j += 1) {
        let sum = 0;
        for (let row = 0; row < r.length; row += 1) sum += columns[i][row] * columns[j][row];
        normal[i][j] = sum;
        normal[j][i] = sum;
      }
    }
    let improved = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const damped = normal.map((row, i) => row.map((value, j) => (i === j ? value + damping * (value + 1e-6) : value)));
      const step = solveLinear(damped, gradient.map((value) => -value));
      if (!step) {
        damping *= 8;
        continue;
      }
      const candidate = x.slice();
      free.forEach((index, i) => {
        candidate[index] = clamp(x[index] + step[i], lower[index], upper[index]);
      });
      const moved = residuals(candidate);
      const movedCost = moved.reduce((total, value) => total + value * value, 0);
      if (movedCost < cost) {
        const gain = cost - movedCost;
        x = candidate;
        r = moved;
        cost = movedCost;
        damping = Math.max(damping * 0.3, 1e-7);
        improved = gain > 1e-9 * (1 + cost);
        break;
      }
      damping *= 4;
    }
    if (!improved) break;
  }
  return { pose: x, cost };
}

// Where a key's surface is and where on it this finger would like to sit.
function contactFor(finger, target) {
  const { key } = target;
  const model = FINGER_MODEL[finger];
  const thumb = finger === 1;
  const range = key.black
    ? [key.zBack + 0.008, key.zFront - 0.006]
    : [thumb ? BLACK_FRONT - 0.012 : key.zBack + 0.01, -0.007];
  return { key, range, preferred: key.black ? model.depth.black : model.depth.white, state: target.state ?? "rest" };
}

function surfaceUnder(contact, z) {
  const { key, state } = contact;
  if (state === "pressed") return key.top - keyDipAt(z, 1);
  if (state === "lifted") return key.top + LIFT;
  return key.top;
}

const MM = 1000;

function buildResiduals(rig, contacts, scale, options) {
  const { lower, upper } = options;
  // A left hand is solved as a mirrored right hand, so look the real keyboard
  // up through the mirror.
  const heightAt = options.mirror ? (x, z) => surfaceHeight(-x, z) : surfaceHeight;
  const restAngles = restPose();
  const curl = options.curl ?? 0;
  for (const finger of LONG_FINGERS) {
    restAngles[OFFSET[finger] + 1] += curl * 12 * DEG;
    restAngles[OFFSET[finger] + 2] += curl * 22 * DEG;
  }
  const assigned = FINGERS.filter((finger) => contacts[finger]);

  return (pose) => {
    const out = [];
    const hand = handMatrix(pose, scale);
    const points = {};
    for (const finger of FINGERS) points[finger] = fingerPoints(rig, finger, pose, hand);

    for (const finger of FINGERS) {
      const entry = rig.fingers[finger];
      const radius = entry.radius * scale;
      const { ball, joints } = points[finger];
      const contact = contacts[finger];
      if (contact) {
        const { key, range, preferred } = contact;
        const tolerance = key.black ? 0.0012 : 0.0025;
        const sideways = ball[0] - keyCenterAt(key, ball[2]);
        out.push(Math.sign(sideways) * hinge(Math.abs(sideways) - tolerance) * MM * 4);
        out.push((ball[1] - radius - surfaceUnder(contact, ball[2])) * MM * 4);
        out.push((hinge(range[0] - ball[2]) - hinge(ball[2] - range[1])) * MM * 4);
        out.push((ball[2] - preferred) * MM * 0.1);
      } else {
        const floor = heightAt(ball[0], ball[2]);
        out.push((ball[1] - radius - floor - HOVER) * MM * 0.7);
        // Idle fingers still stay over the keys rather than curling under the palm.
        out.push(hinge(ball[2] + 0.004) * MM * 0.5);
      }
      // Knuckles must clear whatever they pass over.
      joints.forEach((joint, index) => {
        const clearance = radius * (index === 0 ? 1.35 : 1.1) + 0.0015;
        out.push(hinge(heightAt(joint[0], joint[2]) + clearance - joint[1]) * MM * 3);
      });
    }

    // Neighbouring fingertips cannot share the same space.
    for (let finger = 1; finger < 5; finger += 1) {
      const a = points[finger].ball;
      const b = points[finger + 1].ball;
      const room = (rig.fingers[finger].radius + rig.fingers[finger + 1].radius) * scale * 1.02;
      out.push(hinge(room - Math.hypot(a[0] - b[0], a[2] - b[2], (a[1] - b[1]) * 0.5)) * MM * 2);
      // Fingers stay in order across the keyboard.
      out.push(hinge(a[0] - b[0] + 0.004) * MM * 1.5);
    }

    // Comfort: stay near the relaxed shape, and keep neighbours curling together.
    for (const finger of FINGERS) {
      const offset = OFFSET[finger];
      const weights = finger === 1 ? [6, 7, 5] : [11, 5, 5];
      for (let index = 0; index < 3; index += 1) {
        const value = pose[offset + index];
        out.push((value - restAngles[offset + index]) * weights[index]);
        // Lean on the joint limits softly before the hard stop.
        const margin = 4 * DEG;
        out.push(hinge(lower[offset + index] + margin - value) * 60);
        out.push(hinge(value - (upper[offset + index] - margin)) * 60);
      }
    }
    for (let finger = 2; finger < 5; finger += 1) {
      const looseness = contacts[finger] && contacts[finger + 1] ? 1.5 : 4;
      out.push((pose[OFFSET[finger] + 1] - pose[OFFSET[finger + 1] + 1]) * looseness);
    }
    out.push((pose[3] - restAngles[3]) * 16);
    out.push((pose[4] - restAngles[4] - (options.lift ?? 0) * 10 * DEG) * 12);
    out.push((pose[5] - restAngles[5]) * 22);
    if (!assigned.length) out.push(0);
    return out;
  };
}

// Put the relaxed hand where its fingertips are nearest their keys.
function initialPose(rig, contacts, scale) {
  const pose = restPose();
  const hand = handMatrix(pose, scale);
  let count = 0;
  const sum = [0, 0, 0];
  for (const finger of FINGERS) {
    const contact = contacts[finger];
    if (!contact) continue;
    const { ball } = fingerPoints(rig, finger, pose, hand);
    const z = contact.preferred;
    sum[0] += keyCenterAt(contact.key, z) - ball[0];
    sum[1] += surfaceUnder(contact, z) + rig.fingers[finger].radius * scale - ball[1];
    sum[2] += z - ball[2];
    count += 1;
  }
  if (count) {
    pose[0] = sum[0] / count;
    pose[1] = sum[1] / count;
    pose[2] = sum[2] / count;
  }
  return pose;
}

function contactError(rig, contacts, pose, scale) {
  const hand = handMatrix(pose, scale);
  let worst = 0;
  for (const finger of FINGERS) {
    const contact = contacts[finger];
    if (!contact) continue;
    const { ball } = fingerPoints(rig, finger, pose, hand);
    const radius = rig.fingers[finger].radius * scale;
    const sideways = Math.abs(ball[0] - keyCenterAt(contact.key, ball[2]));
    const height = Math.abs(ball[1] - radius - surfaceUnder(contact, ball[2]));
    const along = hinge(contact.range[0] - ball[2]) + hinge(ball[2] - contact.range[1]);
    worst = Math.max(worst, hinge(sideways - 0.004), height, along);
  }
  return worst;
}

const ALL_FREE = Array.from({ length: POSE_SIZE }, (_, index) => index);

// targets: [{ finger, key, state }] where state is "rest", "pressed" or "lifted".
// Returns the pose, the hand scale it needed, and how far off the worst
// fingertip is (in metres) so callers can tell a reach from a miss.
export function solvePose(rig, targets, options = {}) {
  const { lower, upper } = bounds();
  const baseScale = options.scale ?? 1;
  const contactsFor = (list) => {
    const contacts = {};
    for (const target of list) contacts[target.finger] = contactFor(target.finger, target);
    return contacts;
  };
  const contacts = contactsFor(targets);

  if (options.from) {
    // Re-solve only the fingers, keeping the hand where an earlier solve put it.
    const free = ALL_FREE.filter((index) => index >= 6);
    const residuals = buildResiduals(rig, contacts, options.from.scale, { ...options, lower, upper });
    const { pose } = minimize(residuals, options.from.pose, { lower, upper, free, iterations: 30 });
    return { pose, scale: options.from.scale, error: contactError(rig, contacts, pose, options.from.scale) };
  }

  let best = null;
  // A span the hand cannot cover gets a slightly bigger hand, never longer fingers.
  for (const grow of [1, 1.05, 1.1, 1.16]) {
    const scale = baseScale * grow;
    const residuals = buildResiduals(rig, contacts, scale, { ...options, lower, upper });
    const start = initialPose(rig, contacts, scale);
    let result = minimize(residuals, start, { lower, upper, free: ALL_FREE });
    for (const yaw of [-14, 14]) {
      if (contactError(rig, contacts, result.pose, scale) < 0.0015) break;
      const turned = start.slice();
      turned[3] = yaw * DEG;
      const other = minimize(residuals, turned, { lower, upper, free: ALL_FREE });
      if (other.cost < result.cost) result = other;
    }
    const error = contactError(rig, contacts, result.pose, scale);
    if (!best || error < best.error - 0.0005) best = { pose: result.pose, scale, error, cost: result.cost };
    if (error < 0.0015) break;
  }
  return best;
}

export function blendPose(a, b, t) {
  return {
    pose: a.pose.map((value, index) => value + (b.pose[index] - value) * t),
    scale: a.scale + (b.scale - a.scale) * t,
  };
}

export function describePose(pose) {
  const out = {};
  HAND_VARS.forEach((name, index) => {
    out[name] = index < 3 ? pose[index] : pose[index] / DEG;
  });
  for (const finger of FINGERS) {
    out[finger] = Object.fromEntries(FINGER_VARS[finger].map((name, index) => [name, pose[OFFSET[finger] + index] / DEG]));
  }
  return out;
}

export { FINGER_MODEL, KEYBOARD };
