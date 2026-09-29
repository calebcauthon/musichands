import { getKeyboardWindow, isBlackNote, midiToNote, noteToMidi } from "./hand-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_WIDTH = 1040;
const VIEW_HEIGHT = 520;

// Hand proportions in finger units (U): one unit is the width of the middle
// finger at its knuckle. Everything is described for a right hand seen from
// above, x running toward the pinky and y running toward the wrist; the left
// hand is a mirror image. Knuckle positions are relative to the palm origin,
// which sits on the knuckle line under the middle finger. The keys are drawn
// foreshortened, so local y is squashed by FORESHORTEN to match.
const FORESHORTEN = 0.68;
const HAND = {
  fingerLength: 4.6, // middle finger, knuckle to tip, before curl
  // `splay` is the finger's relaxed angle from the palm axis; `splayLimit` is
  // how far it can swing from that before the whole hand has to turn.
  fingers: {
    2: { width: 0.98, length: 0.92, knuckle: { x: -2.45, y: -0.15 }, splay: -7, splayLimit: 38, fan: -1, whiteDepth: 235, blackDepth: 150 },
    3: { width: 1.0, length: 1.0, knuckle: { x: -0.82, y: -0.4 }, splay: -1, splayLimit: 26, fan: -0.3, whiteDepth: 225, blackDepth: 140 },
    4: { width: 0.94, length: 0.95, knuckle: { x: 0.8, y: -0.2 }, splay: 5, splayLimit: 26, fan: 0.3, whiteDepth: 230, blackDepth: 145 },
    5: { width: 0.82, length: 0.75, knuckle: { x: 2.35, y: 0.5 }, splay: 13, splayLimit: 42, fan: 1, whiteDepth: 250, blackDepth: 160 },
  },
  thumb: {
    width: 1.22,
    cmc: { x: -2.2, y: 4.0 }, // base joint, inside the palm near the wrist
    metacarpal: 2.5, // base joint to knuckle, hidden inside the thenar
    proximal: 1.35,
    distal: 1.2,
    bend: 26, // degrees of flex at the last joint
    abduction: [18, 100], // degrees the metacarpal can swing out from the palm axis
    rest: { x: -3.4, y: -4.0 }, // tip offset from the base joint when the thumb is idle
    whiteDepth: 270,
    blackDepth: 175,
  },
};
const FINGER_ORDER = [2, 3, 4, 5];
const MAX_TURN = 12; // degrees the palm may rotate either way
const MIN_CURL = 0.62; // a finger may curl down to this share of its drawn length, never stretch past it
const THUMB_MIN_ANGLE = 22; // degrees from base joint to tip the thumb stays out from the finger axis
// How far along a key a fingertip may sit, measured from the top of the key.
const WHITE_DEPTH_RANGE = [90, 300]; // may reach up between the black keys
const BLACK_DEPTH_RANGE = [100, 138];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const fmt = (value) => Number(value).toFixed(1);
const pt = (point) => `${fmt(point.x)} ${fmt(point.y)}`;
const rad = (degrees) => (degrees * Math.PI) / 180;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (v, k) => ({ x: v.x * k, y: v.y * k });
const len = (v) => Math.hypot(v.x, v.y);
const norm = (v) => {
  const length = len(v) || 1;
  return { x: v.x / length, y: v.y / length };
};
const perp = (v) => ({ x: -v.y, y: v.x });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const rot = (v, angle) => ({
  x: v.x * Math.cos(angle) - v.y * Math.sin(angle),
  y: v.x * Math.sin(angle) + v.y * Math.cos(angle),
});
const dist = (a, b) => len(sub(a, b));
const signedAngle = (from, to) => Math.atan2(from.x * to.y - from.y * to.x, dot(from, to));
const bump = (t, center, spread) => Math.exp(-(((t - center) / spread) ** 2));

function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function bezierTangent(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return norm({
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  });
}

// Smooth closed outline through a list of points (Catmull-Rom → cubic Béziers).
function smoothClosedPath(points) {
  const count = points.length;
  const at = (index) => points[(index + count) % count];
  let path = `M ${pt(points[0])}`;
  for (let index = 0; index < count; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    path += ` C ${pt(c1)}, ${pt(c2)}, ${pt(p2)}`;
  }
  return `${path} Z`;
}

// Open Catmull-Rom spline through the points, sampled by t in [0, 1] with one
// equal share of t per segment. Returns the point and unit tangent at t.
function splineSampler(points) {
  const segments = points.length - 1;
  const at = (index) => points[clamp(index, 0, points.length - 1)];
  return (t) => {
    const s = clamp(t, 0, 1) * segments;
    const index = Math.min(Math.floor(s), segments - 1);
    const u = s - index;
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    return { point: bezierPoint(p1, c1, c2, p2, u), tangent: bezierTangent(p1, c1, c2, p2, u) };
  };
}

// Sweep a width profile along a centerline and close it with a fingertip pad.
function buildTube(sampleAt, [tStart, tEnd], halfAt, steps = 22) {
  const left = [];
  const right = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = tStart + (tEnd - tStart) * (index / steps);
    const { point, tangent } = sampleAt(t);
    const normal = perp(tangent);
    const half = halfAt(t);
    left.push(add(point, scale(normal, half)));
    right.push(sub(point, scale(normal, half)));
  }
  const end = sampleAt(tEnd);
  const half = halfAt(tEnd);
  const normal = perp(end.tangent);
  const capLength = half * 0.95;
  const cap = [];
  for (let index = 1; index < 8; index += 1) {
    const angle = Math.PI / 2 - (Math.PI * index) / 8;
    // Slightly squared fingertip pad rather than a pure semicircle.
    const along = Math.cos(angle) ** 0.85 * capLength;
    const across = Math.sin(angle) * half;
    cap.push(add(end.point, add(scale(end.tangent, along), scale(normal, across))));
  }
  return {
    outline: smoothClosedPath([...left, ...cap, ...right.reverse()]),
    tipEnd: add(end.point, scale(end.tangent, capLength)),
    tangent: end.tangent,
    normal,
    tipHalf: half,
  };
}

function creaseAt(sampleAt, t, half, reachScale = 0.62) {
  const { point, tangent } = sampleAt(t);
  const normal = perp(tangent);
  const reach = half * reachScale;
  const a = add(point, scale(normal, reach));
  const b = sub(point, scale(normal, reach));
  const control = add(point, scale(tangent, half * 0.22));
  return `M ${pt(a)} Q ${pt(control)} ${pt(b)}`;
}

function nailAt(tube, { across, along, offset = 0 }) {
  const center = add(sub(tube.tipEnd, scale(tube.tangent, along * 1.05)), scale(tube.normal, offset));
  return {
    cx: center.x,
    cy: center.y,
    rx: across,
    ry: along,
    angle: (Math.atan2(tube.tangent.y, tube.tangent.x) * 180) / Math.PI + 90,
  };
}

// Width of a long finger along its visible length: a gentle taper, slightly
// fuller at the joints, a soft pad at the tip.
function fingerWidthProfile(t) {
  const along = Math.max(0, t);
  return 1 - 0.15 * along + 0.045 * bump(t, 0.47, 0.09) + 0.035 * bump(t, 0.76, 0.08) + 0.02 * bump(t, 0.93, 0.08);
}

// Thumb width along its centerline. t runs base joint (0) → knuckle (1/3) →
// last joint (2/3) → tip (1), so the joints get their bulges at those marks.
// The first third is the metacarpal inside the thenar, which is much broader.
function thumbWidthProfile(t) {
  const trunk = t < 0.33 ? 1.34 - 0.3 * (t / 0.33) : 1.04 - 0.14 * ((t - 0.33) / 0.67);
  return trunk + 0.05 * bump(t, 0.33, 0.08) + 0.06 * bump(t, 0.67, 0.08) + 0.04 * bump(t, 0.9, 0.08);
}

function keyboardGeometry(fingers, hand) {
  const whiteNotes = getKeyboardWindow(fingers, 12, hand);
  const keyboardX = 54;
  const keyboardY = 54;
  const keyboardWidth = 932;
  const whiteWidth = keyboardWidth / whiteNotes.length;
  const whiteHeight = 258;
  const blackWidth = whiteWidth * 0.62;
  const blackHeight = 150;

  const whites = whiteNotes.map((entry, index) => ({
    ...entry,
    x: keyboardX + index * whiteWidth,
    y: keyboardY,
    width: whiteWidth,
    height: whiteHeight,
    centerX: keyboardX + index * whiteWidth + whiteWidth / 2,
  }));

  const blacks = [];
  whites.slice(0, -1).forEach((white, index) => {
    const blackMidi = white.midi + 1;
    const blackNote = midiToNote(blackMidi);
    if (!isBlackNote(blackNote)) return;
    blacks.push({
      note: blackNote,
      midi: blackMidi,
      x: white.x + whiteWidth - blackWidth / 2,
      y: keyboardY,
      width: blackWidth,
      height: blackHeight,
      centerX: white.x + whiteWidth,
      whiteIndex: index,
    });
  });

  const keyByMidi = new Map([...whites, ...blacks].map((key) => [key.midi, key]));
  return { whites, blacks, keyByMidi, keyboardX, keyboardY, keyboardWidth, whiteHeight };
}

// The palm frame: where the knuckle line sits and how the hand is turned.
function makeFrame(origin, theta, U) {
  const squash = (local) => ({ x: local.x * U, y: local.y * U * FORESHORTEN });
  const unsquash = (v) => ({ x: v.x / U, y: v.y / (U * FORESHORTEN) });
  return {
    origin,
    theta,
    U,
    toWorld: (local) => add(origin, rot(squash(local), theta)),
    toLocal: (world) => unsquash(rot(sub(world, origin), -theta)),
    direction: (local) => rot(local, theta),
    up: rot({ x: 0, y: -1 }, theta),
  };
}

// Every finger is drawn at one fixed length; a curled finger seen from above
// is this much of its true length.
const drawnLength = (finger, U, curl) => HAND.fingerLength * HAND.fingers[finger].length * U * curl;
const naturalDirection = (finger) => ({ x: Math.sin(rad(HAND.fingers[finger].splay)), y: -Math.cos(rad(HAND.fingers[finger].splay)) });

function thumbChord(U) {
  const p = HAND.thumb.proximal * U;
  const q = HAND.thumb.distal * U;
  const beta = rad(HAND.thumb.bend);
  return {
    length: Math.sqrt(p * p + q * q + 2 * p * q * Math.cos(beta)),
    // Angle between the proximal segment and the straight line to the tip.
    offset: Math.atan2(q * Math.sin(beta), p + q * Math.cos(beta)),
  };
}

// The thumb's joints for a given tip: the metacarpal swings out from the base
// joint as far as it must (within its range), and the two visible segments,
// of fixed length, run from the knuckle to the tip. `residual` is how much
// longer or shorter than real the visible thumb would have to be.
function thumbJoints(tip, frame) {
  const { U } = frame;
  const cmc = frame.toWorld(HAND.thumb.cmc);
  const palmCenter = frame.toWorld({ x: 0, y: 2.2 });
  const a = HAND.thumb.metacarpal * U;
  const chord = thumbChord(U);
  const v = sub(tip, cmc);
  const distance = len(v) || 1;
  const u = norm(v);
  let metacarpalDirection;
  if (distance >= a + chord.length) {
    metacarpalDirection = u;
  } else {
    const along = (distance * distance + a * a - chord.length * chord.length) / (2 * distance);
    const lift = Math.sqrt(Math.max(a * a - along * along, 0));
    const foot = add(cmc, scale(u, along));
    const candidates = [add(foot, scale(perp(u), lift)), add(foot, scale(perp(u), -lift))];
    // The knuckle bulges away from the palm.
    const mcp = candidates.sort((p, q) => dist(q, palmCenter) - dist(p, palmCenter))[0];
    metacarpalDirection = norm(sub(mcp, cmc));
  }
  // Keep the metacarpal within the range a thumb can actually swing.
  const [minOut, maxOut] = HAND.thumb.abduction.map(rad);
  const outAngle = -signedAngle(frame.up, metacarpalDirection);
  const clampedOut = clamp(outAngle, minOut, maxOut);
  if (clampedOut !== outAngle) metacarpalDirection = rot(frame.up, -clampedOut);
  const mcp = add(cmc, scale(metacarpalDirection, a));
  const chordVector = sub(tip, mcp);
  const chordDirection = norm(chordVector);
  const residual = len(chordVector) - chord.length;
  const options = [1, -1].map((sign) => {
    const proximalDirection = rot(chordDirection, -sign * chord.offset);
    return { proximalDirection, ip: add(mcp, scale(proximalDirection, HAND.thumb.proximal * U)) };
  });
  // The last joint bends toward the palm, so it too bulges away from it.
  const { proximalDirection, ip } = options.sort((p, q) => dist(q.ip, palmCenter) - dist(p.ip, palmCenter))[0];
  return { cmc, mcp, ip, tip, proximalDirection, metacarpalDirection, chordDirection, residual, palmCenter };
}

// Where a fingertip must sit on its key for the finger to keep its length,
// given where the knuckle is. The tip slides along the key; only when the key
// is out of reach does the finger's drawn length have to give.
function tipOnKey(target, knuckle, length) {
  const dx = target.x - knuckle.x;
  const ideal = Math.abs(dx) < length ? knuckle.y - Math.sqrt(length * length - dx * dx) : knuckle.y;
  return { x: target.x, y: clamp(ideal, target.depthRange[0], target.depthRange[1]) };
}

// Slide and turn the palm until every assigned finger, at its fixed length,
// lands on its key, no finger has to splay further than a real one can, and
// the thumb comes in from the side at a natural angle.
function solveFrame({ targets, thumbTarget, U, curl, palmOffset, floorY }) {
  const fingers = FINGER_ORDER.map((finger) => targets.get(finger)).filter(Boolean);
  const knuckleWorld = (finger, frame) => frame.toWorld(HAND.fingers[finger].knuckle);

  let theta = 0;
  if (fingers.length >= 2) {
    const first = fingers[0];
    const last = fingers[fingers.length - 1];
    const tipAngle = Math.atan2(last.defaultY - first.defaultY, last.x - first.x);
    const knuckleAngle = Math.atan2(
      (HAND.fingers[last.finger].knuckle.y - HAND.fingers[first.finger].knuckle.y) * FORESHORTEN,
      HAND.fingers[last.finger].knuckle.x - HAND.fingers[first.finger].knuckle.x,
    );
    theta = clamp((tipAngle - knuckleAngle) * 0.35, rad(-MAX_TURN), rad(MAX_TURN));
  }

  let frame = makeFrame({ x: 0, y: 0 }, theta, U);
  let origin;
  if (fingers.length) {
    const sum = fingers.reduce((total, target) => {
      const reach = scale(rot(naturalDirection(target.finger), theta), drawnLength(target.finger, U, curl));
      const estimate = sub({ x: target.x, y: target.defaultY }, add(sub(knuckleWorld(target.finger, frame), frame.origin), reach));
      return add(total, estimate);
    }, { x: 0, y: 0 });
    origin = scale(sum, 1 / fingers.length);
  } else {
    // Thumb alone: rest the palm to its pinky side with the thumb reaching out.
    const reach = (HAND.thumb.metacarpal * U + thumbChord(U).length) * 0.8;
    const cmcOffset = sub(frame.toWorld(HAND.thumb.cmc), frame.origin);
    origin = sub({ x: thumbTarget.x, y: thumbTarget.defaultY }, add(cmcOffset, scale({ x: -0.6, y: -0.8 }, reach)));
  }
  origin = add(origin, { x: 0, y: palmOffset });
  const restY = floorY + palmOffset;
  if (origin.y < restY) origin.y = restY;

  for (let iteration = 0; iteration < 120; iteration += 1) {
    frame = makeFrame(origin, theta, U);
    // Prefer the knuckles at or below the front of the keys.
    let move = { x: 0, y: origin.y < restY ? (restY - origin.y) * 0.25 : 0 };
    let turn = 0;
    const pull = (joint, u, amount) => {
      move = add(move, scale(u, amount));
      const arm = sub(joint, origin);
      const armLength = len(arm) || 1;
      turn += (dot(perp(arm), u) * amount) / (armLength * armLength) * 0.6 * armLength;
    };
    for (const target of fingers) {
      const knuckle = knuckleWorld(target.finger, frame);
      const length = drawnLength(target.finger, U, curl);
      const tip = tipOnKey(target, knuckle, length);
      const v = sub(tip, knuckle);
      const u = norm(v);
      const residual = len(v) - length;
      // Fingers never stretch past their length; they may curl shorter, but
      // drift back toward full length when nothing stops them.
      if (residual > 0) pull(knuckle, u, residual);
      else if (residual < -(1 - MIN_CURL) * length) pull(knuckle, u, residual + (1 - MIN_CURL) * length);
      else pull(knuckle, u, residual * 0.15);
      // Drift toward each finger's comfortable depth on the key.
      move.y += (target.defaultY - tip.y) * 0.12;
      const deviation = signedAngle(frame.direction(naturalDirection(target.finger)), u);
      const limit = rad(HAND.fingers[target.finger].splayLimit);
      if (Math.abs(deviation) > limit) turn += Math.sign(deviation) * (Math.abs(deviation) - limit) * 0.5;
    }
    if (thumbTarget) {
      const cmc = frame.toWorld(HAND.thumb.cmc);
      const probe = tipOnKey(thumbTarget, cmc, HAND.thumb.metacarpal * U + thumbChord(U).length * 0.9);
      const joints = thumbJoints(probe, frame);
      pull(joints.mcp, joints.chordDirection, joints.residual);
      move.y += (thumbTarget.defaultY - probe.y) * 0.12;
      // A thumb never points straight up beside the fingers: it comes in from
      // the side, so slide the palm toward the pinky until it does.
      const outAngle = -signedAngle(frame.up, norm(sub(probe, cmc)));
      if (outAngle < rad(THUMB_MIN_ANGLE)) {
        move = add(move, scale(rot({ x: 1, y: 0 }, theta), (rad(THUMB_MIN_ANGLE) - outAngle) * U * 0.8));
      }
    }
    const count = fingers.length + (thumbTarget ? 1 : 0);
    move = scale(move, 0.7 / Math.max(1, count * 0.6));
    if (len(move) < 0.05 && Math.abs(turn) < 0.0005) break;
    origin = add(origin, move);
    theta = clamp(theta + turn * 0.5, rad(-MAX_TURN), rad(MAX_TURN));
  }
  return makeFrame(origin, theta, U);
}

// Where idle fingers hover: between their assigned neighbours, following the
// hand's spread, slightly shorter because they are lifted off the keys.
function restingTip(finger, placedTips, frame, curl) {
  const { U } = frame;
  const knuckle = frame.toWorld(HAND.fingers[finger].knuckle);
  const deviationOf = (other) => {
    const tip = placedTips.get(other);
    if (!tip) return null;
    return signedAngle(frame.direction(naturalDirection(other)), norm(sub(tip, frame.toWorld(HAND.fingers[other].knuckle))));
  };
  const lower = FINGER_ORDER.filter((other) => other < finger).map(deviationOf).filter((d) => d !== null).pop();
  const upper = FINGER_ORDER.filter((other) => other > finger).map(deviationOf).filter((d) => d !== null)[0];
  let deviation = 0;
  if (lower !== undefined && upper !== undefined) deviation = (lower + upper) / 2;
  else if (lower !== undefined || upper !== undefined) deviation = (lower ?? upper) * 0.8;
  const direction = rot(frame.direction(naturalDirection(finger)), deviation);
  return add(knuckle, scale(direction, drawnLength(finger, U, curl) * 0.96));
}

function buildFinger({ finger, tip, frame, width, targeted, curl }) {
  const knuckle = frame.toWorld(HAND.fingers[finger].knuckle);
  const v = sub(tip, knuckle);
  const distance = len(v) || 1;
  const u = norm(v);
  const stretch = distance / (HAND.fingerLength * HAND.fingers[finger].length * frame.U);
  // A faint sideways bow in the direction the finger fans when the hand relaxes.
  const bow = scale(perp(u), distance * 0.035 * HAND.fingers[finger].fan);
  const p0 = knuckle;
  const p1 = add(add(knuckle, scale(v, 0.36)), bow);
  const p2 = add(add(knuckle, scale(v, 0.72)), scale(bow, 0.6));
  const p3 = tip;
  const sampleAt = (t) => ({ point: bezierPoint(p0, p1, p2, p3, t), tangent: bezierTangent(p0, p1, p2, p3, t) });
  const halfAt = (t) => (width * fingerWidthProfile(t)) / 2;
  // Start well behind the knuckle so the finger runs in under the palm.
  const tube = buildTube(sampleAt, [-0.3, 1], halfAt);
  const creases = [creaseAt(sampleAt, 0.47, halfAt(0.47)), creaseAt(sampleAt, 0.76, halfAt(0.76))];
  // A curled finger shows less of its nail from above.
  const nail = nailAt(tube, { across: tube.tipHalf * 0.55, along: tube.tipHalf * (0.5 + 0.4 * Math.min(1, stretch / curl)) });
  return { finger, tip, knuckle, targeted, ...tube, creases, nail };
}

// The visible thumb: the two segments from the knuckle at the palm's edge to
// the tip, with a bend at the last joint. The metacarpal behind the knuckle is
// buried in the thenar and drawn as part of the palm.
function buildThumb({ tip, frame, width, targeted }) {
  const { U } = frame;
  const joints = thumbJoints(tip, frame);
  const { mcp, ip, proximalDirection, palmCenter } = joints;
  const base = sub(mcp, scale(proximalDirection, 0.8 * U));
  const sampleAt = splineSampler([base, mcp, ip, tip]);
  const halfAt = (t) => (width * thumbWidthProfile(t)) / 2;
  const tube = buildTube(sampleAt, [0, 1], halfAt, 30);
  const creases = [creaseAt(sampleAt, 0.67, halfAt(0.67), 0.7), creaseAt(sampleAt, 0.36, halfAt(0.36), 0.42)];
  // Seen from above, the nail sits toward the outer edge of the tip.
  let outward = perp(tube.tangent);
  if (dot(outward, sub(tube.tipEnd, palmCenter)) < 0) outward = scale(outward, -1);
  const nail = nailAt(tube, {
    across: tube.tipHalf * 0.5,
    along: tube.tipHalf * 0.8,
    offset: dot(outward, tube.normal) * tube.tipHalf * 0.22,
  });
  return { finger: 1, tip, targeted, ...tube, creases, nail, joints };
}

// Back of the hand: scalloped knuckle line, hypothenar bulge on the pinky
// side, the wrist running off the bottom of the picture, then the thenar mass
// wrapping the thumb's metacarpal and the web curving back to the index.
function buildPalm(frame, thumb, thumbWidth) {
  const { toWorld, toLocal } = frame;
  const knuckles = HAND.fingers;
  const top = [];
  FINGER_ORDER.forEach((finger, index) => {
    const knuckle = knuckles[finger].knuckle;
    top.push({ x: knuckle.x, y: knuckle.y - 0.3 });
    if (finger !== 5) {
      const next = knuckles[FINGER_ORDER[index + 1]].knuckle;
      top.push({ x: (knuckle.x + next.x) / 2, y: Math.max(knuckle.y, next.y) + 0.25 });
    }
  });
  const { cmc, mcp, proximalDirection, metacarpalDirection } = thumb.joints;
  const halfThumb = thumbWidth / 2;
  const palmCenter = frame.toWorld({ x: 0, y: 2.2 });
  let outward = perp(metacarpalDirection);
  if (dot(outward, sub(mcp, palmCenter)) < 0) outward = scale(outward, -1);
  let proximalOutward = perp(proximalDirection);
  if (dot(proximalOutward, sub(mcp, palmCenter)) < 0) proximalOutward = scale(proximalOutward, -1);
  const thenarA = add(add(cmc, scale(sub(mcp, cmc), 0.3)), scale(outward, halfThumb * 1.5));
  const thenarB = add(add(cmc, scale(sub(mcp, cmc), 0.72)), scale(outward, halfThumb * 1.3));
  const knuckleOuter = add(mcp, scale(proximalOutward, halfThumb * 1.05));
  const webStart = add(add(mcp, scale(proximalDirection, 0.6 * frame.U)), scale(proximalOutward, -halfThumb * 0.95));
  const indexSide = toWorld({ x: -3.15, y: 0.6 });
  const webMid = scale(add(webStart, indexSide), 0.5);
  const web = add(webMid, scale(norm(sub(palmCenter, webMid)), 0.3 * frame.U));
  const points = [
    ...top.map(toWorld),
    toWorld({ x: 3.35, y: 1.0 }),
    toWorld({ x: 3.8, y: 2.6 }),
    toWorld({ x: 3.5, y: 4.3 }),
    toWorld({ x: 2.8, y: 5.3 }),
    toWorld({ x: 0.4, y: 5.6 }),
    toWorld({ x: -2.0, y: 5.4 }),
    toWorld({ x: -2.9, y: 4.6 }),
    thenarA,
    thenarB,
    knuckleOuter,
    webStart,
    web,
    indexSide,
  ];
  return smoothClosedPath(points);
}

function layoutAtScale({ fingerTargets, U, curl, palmOffset, floorY }) {
  const targets = new Map(fingerTargets.map((target) => [target.finger, target]));
  const thumbTarget = targets.get(1) ?? null;
  const frame = solveFrame({ targets, thumbTarget, U, curl, palmOffset, floorY });

  // Final tip positions: assigned fingers slide along their keys to keep
  // their length; anything left over is how far the drawing had to cheat.
  const placedTips = new Map();
  let worstCheat = 0;
  for (const finger of FINGER_ORDER) {
    const target = targets.get(finger);
    if (!target) continue;
    const length = drawnLength(finger, U, curl);
    const knuckle = frame.toWorld(HAND.fingers[finger].knuckle);
    const tip = tipOnKey(target, knuckle, length);
    placedTips.set(finger, tip);
    const residual = dist(tip, knuckle) - length;
    worstCheat = Math.max(worstCheat, residual > 0 ? residual / length : Math.max(0, -residual - (1 - MIN_CURL) * length) / length);
  }
  let thumbTip;
  if (thumbTarget) {
    const cmc = frame.toWorld(HAND.thumb.cmc);
    thumbTip = tipOnKey(thumbTarget, cmc, HAND.thumb.metacarpal * U + thumbChord(U).length * 0.9);
    const joints = thumbJoints(thumbTip, frame);
    worstCheat = Math.max(worstCheat, Math.abs(joints.residual) / thumbChord(U).length);
  } else {
    thumbTip = frame.toWorld(add(HAND.thumb.cmc, HAND.thumb.rest));
  }

  const fingers = FINGER_ORDER.map((finger) => {
    const tip = placedTips.get(finger) ?? restingTip(finger, placedTips, frame, curl);
    return buildFinger({ finger, tip, frame, width: U * HAND.fingers[finger].width, targeted: placedTips.has(finger), curl });
  });
  const thumbWidth = U * HAND.thumb.width;
  const thumb = buildThumb({ tip: thumbTip, frame, width: thumbWidth, targeted: Boolean(thumbTarget) });
  const palmPath = buildPalm(frame, thumb, thumbWidth);
  return { fingers: [thumb, ...fingers], palmPath, frame, worstCheat };
}

function handLayout({ fingerTargets, weight, curve, palmHeight, floorY }) {
  const baseU = Number(weight) * 1.6;
  const curl = 0.62 - ((clamp(Number(curve), 12, 88) - 12) / 76) * 0.14;
  const palmOffset = (Number(palmHeight) - 44) * 0.9;
  // A span the hand cannot cover gets a slightly bigger hand rather than
  // longer fingers, and only as much bigger as it needs.
  let best = null;
  for (const grow of [1, 1.08, 1.16, 1.24]) {
    const U = baseU * grow;
    const layout = layoutAtScale({ fingerTargets, U, curl, palmOffset: palmOffset, floorY: floorY + 0.2 * U });
    if (!best || layout.worstCheat < best.worstCheat - 0.02) best = layout;
    if (layout.worstCheat < 0.06) break;
  }
  return best;
}

export function createHandKeyboardSvg(config) {
  const {
    hand = "right",
    fingers,
    activeMidis = [],
    palmHeight = 44,
    curve = 52,
    weight = 30,
    showNotes = true,
    showGuides = true,
  } = config;

  const mirrored = hand === "left";
  // The hand is modelled as a right hand; a left hand is drawn in a mirrored
  // frame and its annotations are mapped back with `place`.
  const place = (point) => (mirrored ? { x: VIEW_WIDTH - point.x, y: point.y } : point);

  const geometry = keyboardGeometry(fingers, hand);
  const activeSet = new Set([...activeMidis].map(Number));
  const fingerByMidi = new Map(fingers.map((finger) => [noteToMidi(finger.note), finger]));
  const assignedSet = new Set(fingerByMidi.keys());
  const fingerTargets = fingers.map((finger) => {
    const midi = noteToMidi(finger.note);
    const key = geometry.keyByMidi.get(midi);
    const anatomy = finger.finger === 1 ? HAND.thumb : HAND.fingers[finger.finger];
    const black = isBlackNote(finger.note);
    const range = black ? BLACK_DEPTH_RANGE : WHITE_DEPTH_RANGE;
    return {
      ...finger,
      midi,
      x: place({ x: key.centerX, y: 0 }).x,
      defaultY: key.y + (black ? anatomy.blackDepth : anatomy.whiteDepth),
      depthRange: [key.y + range[0], key.y + range[1]],
    };
  });
  const midiByFinger = new Map(fingerTargets.map((target) => [target.finger, target.midi]));

  const layout = handLayout({ fingerTargets, weight, curve, palmHeight, floorY: geometry.keyboardY + geometry.whiteHeight });
  const whiteKeys = geometry.whites.map((key) => {
    const assigned = assignedSet.has(key.midi);
    const active = activeSet.has(key.midi);
    const classes = ["piano-key", "white-key", assigned ? "is-assigned" : "", active ? "is-active" : ""]
      .filter(Boolean)
      .join(" ");
    return `
      <g class="${classes}" data-note="${key.note}" data-midi="${key.midi}" role="button" tabindex="0" aria-label="Play ${key.note}">
        <rect x="${key.x.toFixed(2)}" y="${key.y}" width="${key.width.toFixed(2)}" height="${key.height}" rx="2" />
        ${showNotes ? `<text class="key-note" x="${key.centerX.toFixed(2)}" y="${key.y + key.height - 18}" text-anchor="middle">${escapeXml(key.note)}</text>` : ""}
      </g>`;
  }).join("");

  const blackKeys = geometry.blacks.map((key) => {
    const assigned = assignedSet.has(key.midi);
    const active = activeSet.has(key.midi);
    const classes = ["piano-key", "black-key", assigned ? "is-assigned" : "", active ? "is-active" : ""]
      .filter(Boolean)
      .join(" ");
    return `
      <g class="${classes}" data-note="${key.note}" data-midi="${key.midi}" role="button" tabindex="0" aria-label="Play ${key.note}">
        <rect x="${key.x.toFixed(2)}" y="${key.y}" width="${key.width.toFixed(2)}" height="${key.height}" rx="3" />
        ${showNotes && assigned ? `<text class="key-note key-note--black" x="${key.centerX.toFixed(2)}" y="${key.y + 96}" text-anchor="middle">${escapeXml(key.note)}</text>` : ""}
      </g>`;
  }).join("");

  const playing = layout.fingers.filter((finger) => finger.targeted);
  const isActive = (finger) => activeSet.has(midiByFinger.get(finger.finger));
  const badgeFor = (finger) => place(add(finger.tipEnd, scale(finger.tangent, 17)));

  const guideLines = showGuides
    ? playing
        .filter((finger) => finger.finger === 1 || finger.finger === 5)
        .map((finger) => {
          const badge = badgeFor(finger);
          const tip = place(finger.tip);
          return `
          <g class="anchor-guide">
            <line x1="${fmt(tip.x)}" y1="${fmt(badge.y - 14)}" x2="${fmt(tip.x)}" y2="39" />
            <text x="${fmt(tip.x)}" y="31" text-anchor="middle">${finger.finger === 1 ? "THUMB" : "PINKY"}</text>
          </g>`;
        })
        .join("")
    : "";

  const halos = playing.map((finger) => {
    const tip = place(finger.tip);
    return `
      <circle class="touch-halo ${isActive(finger) ? "is-active" : ""}" data-finger="${finger.finger}" cx="${fmt(tip.x)}" cy="${fmt(tip.y)}" r="${fmt(finger.tipHalf * 1.5)}" />`;
  }).join("");

  const fingerShapes = layout.fingers.map((finger) => `
        <path class="finger-fill" data-finger="${finger.finger}" d="${finger.outline}" />`).join("");

  const fingerDetails = layout.fingers.map((finger) => `
      <g class="hand-finger ${isActive(finger) ? "is-active" : ""} ${finger.targeted ? "" : "is-resting"}" data-finger="${finger.finger}">
        ${finger.creases.map((crease) => `<path class="finger-crease" d="${crease}" />`).join("")}
        <ellipse class="fingernail" cx="${fmt(finger.nail.cx)}" cy="${fmt(finger.nail.cy)}" rx="${fmt(finger.nail.rx)}" ry="${fmt(finger.nail.ry)}" transform="rotate(${fmt(finger.nail.angle)} ${fmt(finger.nail.cx)} ${fmt(finger.nail.cy)})" />
      </g>`).join("");

  const badges = playing.map((finger) => {
    const badge = badgeFor(finger);
    return `
      <g class="finger-badge" data-finger="${finger.finger}">
        <circle cx="${fmt(badge.x)}" cy="${fmt(badge.y)}" r="9.5" />
        <text class="finger-number" x="${fmt(badge.x)}" y="${fmt(badge.y + 4)}" text-anchor="middle">${finger.finger}</text>
      </g>`;
  }).join("");

  const handLabel = hand === "right" ? "RIGHT HAND" : "LEFT HAND";
  const playerViewLabel = `PLAYER VIEW · ${handLabel}`;
  const glow = layout.frame.toWorld({ x: 0, y: 1.6 });
  const handTransform = mirrored ? ` transform="translate(${VIEW_WIDTH} 0) scale(-1 1)"` : "";

  return `
    <svg class="hand-keyboard" xmlns="${SVG_NS}" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" role="img" aria-label="${handLabel.toLowerCase()} positioned on a piano keyboard">
      <defs>
        <style>
          .hand-keyboard { --paper: #f5edde; --ink: #302016; --ink-soft: #715d50; --clay: #bd512f; --clay-deep: #82351f; --gold: #e9a63a; font-family: "Avenir Next", "Gill Sans", sans-serif; }
          .diagram-label, .diagram-hint { fill: var(--ink-soft); font-size: 11px; font-weight: 700; letter-spacing: 1.7px; }
          .keyboard-shadow rect { fill: #4b35252e; }
          .piano-key { cursor: pointer; }
          .piano-key rect { stroke: var(--ink); stroke-width: 1.2; }
          .white-key rect { fill: #fbf8f1; }
          .white-key.is-assigned rect { fill: #ecd1b1; }
          .black-key rect { fill: var(--ink); }
          .black-key.is-assigned rect { fill: #543022; }
          .piano-key.is-active rect { fill: var(--gold); filter: url(#active-glow); }
          .key-note, .finger-number, .anchor-guide text { pointer-events: none; }
          .key-note { fill: var(--ink-soft); font-size: 12px; font-weight: 600; }
          .key-note--black { fill: var(--paper); font-size: 9px; }
          .anchor-guide { pointer-events: none; }
          .anchor-guide line { stroke: var(--clay); stroke-dasharray: 3 5; stroke-width: 1; }
          .anchor-guide text { fill: var(--clay-deep); font-size: 8px; font-weight: 700; letter-spacing: 1px; }
          .hand, .hand-detail, .finger-badge, .touch-halo { pointer-events: none; }
          .palm, .finger-fill { fill: url(#hand-skin); stroke: none; }
          .finger-crease { fill: none; stroke: #b47c62; stroke-opacity: 0.42; stroke-linecap: round; stroke-width: 1.2; }
          .fingernail { fill: #f6dccf; stroke: #cf9c86; stroke-width: 0.9; }
          .hand-finger.is-resting .fingernail { fill-opacity: 0.8; }
          .finger-badge circle { fill: var(--paper); stroke: var(--clay); stroke-width: 1.2; }
          .finger-number { fill: var(--clay-deep); font-family: Baskerville, serif; font-size: 12px; font-style: italic; font-weight: 700; }
          .touch-halo { fill: transparent; }
          .touch-halo.is-active { fill: #e9a63a80; filter: url(#active-glow); }
        </style>
        <radialGradient id="hand-skin" gradientUnits="userSpaceOnUse" cx="${fmt(glow.x)}" cy="${fmt(glow.y)}" r="${fmt(layout.frame.U * 8)}">
          <stop offset="0" stop-color="#f7dcc8" />
          <stop offset="0.45" stop-color="#f2cdb2" />
          <stop offset="1" stop-color="#e8b696" />
        </radialGradient>
        <filter id="hand-skin-edge" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
          <feMorphology in="SourceAlpha" operator="dilate" radius="1.3" result="dilated" />
          <feFlood flood-color="#b8805f" result="ink" />
          <feComposite in="ink" in2="dilated" operator="in" result="outline" />
          <feMorphology in="SourceAlpha" operator="erode" radius="4.5" result="eroded" />
          <feGaussianBlur in="eroded" stdDeviation="4" result="core" />
          <feFlood flood-color="#c27d5b" flood-opacity="0.3" result="shade" />
          <feComposite in="shade" in2="SourceAlpha" operator="in" result="shade-in" />
          <feComposite in="shade-in" in2="core" operator="out" result="rim" />
          <feMerge result="hand">
            <feMergeNode in="outline" />
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="rim" />
          </feMerge>
          <feDropShadow in="hand" dx="0" dy="6" stdDeviation="7" flood-color="#4d2f23" flood-opacity="0.16" />
        </filter>
        <filter id="active-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="#eea640" flood-opacity="0.9" />
        </filter>
      </defs>

      <text class="diagram-label" x="54" y="${VIEW_HEIGHT - 16}">${playerViewLabel}</text>
      <text class="diagram-hint" x="986" y="${VIEW_HEIGHT - 16}" text-anchor="end">WRIST BELOW · KEYS ABOVE</text>

      <g class="keyboard-shadow">
        <rect x="${geometry.keyboardX - 8}" y="${geometry.keyboardY - 8}" width="${geometry.keyboardWidth + 16}" height="${geometry.whiteHeight + 16}" rx="9" />
      </g>
      <g class="keyboard">${whiteKeys}${blackKeys}</g>

      ${guideLines}
      ${halos}

      <g class="hand"${handTransform} filter="url(#hand-skin-edge)">
        ${fingerShapes}
        <path class="palm" d="${layout.palmPath}" />
      </g>
      <g class="hand-detail"${handTransform}>
        ${fingerDetails}
      </g>
      ${badges}
    </svg>`;
}

export class HandKeyboard {
  constructor(element, config) {
    this.element = element;
    this.config = { ...config, activeMidis: config.activeMidis ?? [] };
    this.pointerMidis = new Set();
    this.render();
  }

  update(nextConfig) {
    this.config = { ...this.config, ...nextConfig };
    this.render();
  }

  setActiveMidis(midis) {
    this.config.activeMidis = [...midis];
    this.render();
  }

  render() {
    this.element.innerHTML = createHandKeyboardSvg(this.config);
    this.bindKeys();
  }

  bindKeys() {
    this.element.querySelectorAll(".piano-key").forEach((key) => {
      const midi = Number(key.dataset.midi);
      const press = (event) => {
        event.preventDefault();
        this.pointerMidis.add(midi);
        this.element.dispatchEvent(new CustomEvent("noteon", { detail: { midi, source: "pointer" } }));
      };
      const release = () => {
        if (!this.pointerMidis.has(midi)) return;
        this.pointerMidis.delete(midi);
        this.element.dispatchEvent(new CustomEvent("noteoff", { detail: { midi, source: "pointer" } }));
      };
      key.addEventListener("pointerdown", press);
      key.addEventListener("pointerup", release);
      key.addEventListener("pointerleave", release);
      key.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && !event.repeat) press(event);
      });
      key.addEventListener("keyup", (event) => {
        if (event.key === "Enter" || event.key === " ") release();
      });
    });
  }

  toSvgString() {
    return createHandKeyboardSvg(this.config);
  }
}
