import { getKeyboardWindow, isBlackNote, midiToNote, noteToMidi } from "./hand-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FINGER_ANATOMY = {
  // Lengths and widths are normalized to the middle finger. Contact depths let
  // a relaxed hand reach farther with the long middle fingers and stay nearer
  // the player with the thumb and pinky while still landing on the assigned key.
  // `knuckle` is how far below the middle-finger knuckle each finger's knuckle
  // sits; `fan` is which way the finger bows when the hand relaxes.
  1: { length: 0.72, width: 1.02, knuckle: 0, whiteDepth: 226, blackDepth: 172, fan: -1 },
  2: { length: 0.91, width: 0.95, knuckle: 0.14, whiteDepth: 168, blackDepth: 118, fan: -0.8 },
  3: { length: 1, width: 1, knuckle: 0, whiteDepth: 152, blackDepth: 102, fan: -0.15 },
  4: { length: 0.94, width: 0.93, knuckle: 0.12, whiteDepth: 160, blackDepth: 110, fan: 0.35 },
  5: { length: 0.74, width: 0.78, knuckle: 0.4, whiteDepth: 184, blackDepth: 134, fan: 1 },
};
const REFERENCE_FINGER_LENGTH = 136;
// The "weight" control is in the old stroke units; real fingers are wider than that.
const WIDTH_SCALE = 1.45;

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const fmt = (value) => Number(value).toFixed(1);
const pt = (point) => `${fmt(point.x)} ${fmt(point.y)}`;

function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function bezierTangent(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const x = 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
  const y = 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
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

const bump = (t, center, spread) => Math.exp(-(((t - center) / spread) ** 2));

// Width of a finger along its length: a gentle taper, slightly fuller at the
// joints, a soft pad at the tip. Thumbs start wide at the thenar and taper more.
function widthProfile(finger, t) {
  if (finger === 1) {
    return 1.02 - 0.1 * Math.max(0, t) + 0.05 * bump(t, 0.5, 0.1) + 0.02 * bump(t, 0.92, 0.08);
  }
  return 1 - 0.15 * Math.max(0, t) + 0.045 * bump(t, 0.44, 0.09) + 0.035 * bump(t, 0.74, 0.08) + 0.02 * bump(t, 0.93, 0.08);
}

// Centerline of a finger from its knuckle to the contact point on the key.
function fingerCurve(knuckle, tip, finger, anatomy, curveAmount, direction) {
  const dx = tip.x - knuckle.x;
  const dy = tip.y - knuckle.y;
  if (finger === 1) {
    // Only the two phalanges show: nearly straight, with a small bend at the
    // joint that turns the tip in toward the other fingers.
    const length = Math.hypot(dx, dy) || 1;
    const outward = { x: (-direction * Math.abs(dy)) / length, y: -Math.abs(dx) / length };
    const bow = curveAmount * 0.1;
    return [
      knuckle,
      { x: knuckle.x + dx * 0.4 + outward.x * bow, y: knuckle.y + dy * 0.4 + outward.y * bow },
      { x: tip.x - dx * 0.3 + outward.x * bow * 0.6, y: tip.y - dy * 0.3 + outward.y * bow * 0.6 },
      tip,
    ];
  }
  const bow = direction * anatomy.fan * curveAmount * 0.2;
  return [
    knuckle,
    { x: knuckle.x + dx * 0.36 + bow, y: knuckle.y + dy * 0.36 },
    { x: tip.x - dx * 0.08 + bow * 0.4, y: tip.y - dy * 0.32 },
    tip,
  ];
}

function buildFinger({ knuckle, tip, finger, anatomy, width, curveAmount, direction }) {
  const [p0, p1, p2, p3] = fingerCurve(knuckle, tip, finger, anatomy, curveAmount, direction);
  const sample = (t) => {
    const point = bezierPoint(p0, p1, p2, p3, t);
    const tangent = bezierTangent(p0, p1, p2, p3, t);
    const normal = { x: -tangent.y, y: tangent.x };
    const half = (width * widthProfile(finger, t)) / 2;
    return { point, tangent, normal, half };
  };

  const left = [];
  const right = [];
  const steps = 18;
  // Start under the palm so the knuckle blends into the hand. The thumb reaches
  // deeper because the palm edge passes beneath it rather than across its base.
  const tStart = finger === 1 ? -0.45 : -0.16;
  for (let index = 0; index <= steps; index += 1) {
    const t = tStart + (1 - tStart) * (index / steps);
    const { point, normal, half } = sample(t);
    left.push({ x: point.x + normal.x * half, y: point.y + normal.y * half });
    right.push({ x: point.x - normal.x * half, y: point.y - normal.y * half });
  }

  const end = sample(1);
  const capLength = end.half * 0.92;
  const cap = [];
  for (let index = 1; index < 8; index += 1) {
    const angle = Math.PI / 2 - (Math.PI * index) / 8;
    // Slightly squared fingertip pad rather than a pure semicircle.
    const along = Math.cos(angle) ** 0.85 * capLength;
    const across = Math.sin(angle) * end.half;
    cap.push({
      x: end.point.x + end.tangent.x * along + end.normal.x * across,
      y: end.point.y + end.tangent.y * along + end.normal.y * across,
    });
  }

  const outline = smoothClosedPath([...left, ...cap, ...right.reverse()]);
  const tipEnd = { x: end.point.x + end.tangent.x * capLength, y: end.point.y + end.tangent.y * capLength };

  const crease = (t, scale = 0.62) => {
    const { point, tangent, normal, half } = sample(t);
    const reach = half * scale;
    const a = { x: point.x + normal.x * reach, y: point.y + normal.y * reach };
    const b = { x: point.x - normal.x * reach, y: point.y - normal.y * reach };
    const control = { x: point.x + tangent.x * half * 0.22, y: point.y + tangent.y * half * 0.22 };
    return `M ${pt(a)} Q ${pt(control)} ${pt(b)}`;
  };
  const creases = finger === 1 ? [crease(0.5, 0.58)] : [crease(0.46), crease(0.75)];

  const nailOffset = finger === 1 ? -direction * end.half * 0.2 : 0;
  const nail = {
    cx: end.point.x + end.normal.x * nailOffset - end.tangent.x * end.half * 0.05,
    cy: end.point.y + end.normal.y * nailOffset - end.tangent.y * end.half * 0.05,
    rx: end.half * (finger === 1 ? 0.5 : 0.58),
    ry: end.half * (finger === 1 ? 0.62 : 0.68),
    angle: (Math.atan2(end.tangent.y, end.tangent.x) * 180) / Math.PI + 90,
  };

  return { outline, creases, nail, tipEnd, tangent: end.tangent, tipHalf: end.half };
}

function keyboardGeometry(fingers) {
  const whiteNotes = getKeyboardWindow(fingers);
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

function handLayout({ hand, fingerTargets, weight, curve, palmHeight }) {
  const direction = hand === "right" ? 1 : -1;
  const W = Number(weight) * WIDTH_SCALE;
  const curveAmount = Number(curve);
  // A curled hand sits closer to the keys, so more curve means shorter reach.
  const reachScale = 1.12 - (curveAmount / 88) * 0.28;
  const gap = W * 0.2;
  const byFinger = new Map(fingerTargets.map((finger) => [finger.finger, finger]));
  const longFingers = [2, 3, 4, 5].map((finger) => byFinger.get(finger)).filter(Boolean);
  const thumb = byFinger.get(1);

  // Palm width comes straight from the fingers that have to fit across the knuckles.
  const knuckleWidths = [2, 3, 4, 5].map((finger) => FINGER_ANATOMY[finger].width * W);
  const palmWidth = knuckleWidths.reduce((total, width) => total + width, 0) + gap * 3;
  const knuckleOffsets = {};
  let cursor = -palmWidth / 2;
  [2, 3, 4, 5].forEach((finger, index) => {
    knuckleOffsets[finger] = cursor + knuckleWidths[index] / 2;
    cursor += knuckleWidths[index] + gap;
  });

  const fingerCenter = longFingers.length
    ? longFingers.reduce((total, finger) => total + finger.x, 0) / longFingers.length
    : fingerTargets.reduce((total, finger) => total + finger.x, 0) / fingerTargets.length;
  let centerX = fingerCenter;
  if (thumb) {
    // Let a wide thumb reach pull the palm toward it a little, as a real hand would.
    const thumbSideX = fingerCenter - direction * (palmWidth / 2 + W * 0.3);
    const reach = Math.max(0, -direction * (thumb.x - thumbSideX) - 105);
    centerX -= direction * reach * 0.3;
  }

  // Place the knuckle line so every finger's drawn length is close to its real length.
  const estimates = [];
  (longFingers.length ? longFingers : fingerTargets).forEach((finger) => {
    const anatomy = finger.anatomy;
    const length = REFERENCE_FINGER_LENGTH * anatomy.length * reachScale;
    const baseX = centerX + direction * (knuckleOffsets[finger.finger] ?? -palmWidth / 2);
    const dx = finger.x - baseX;
    const dy = Math.sqrt(Math.max(length * length - dx * dx, (length * 0.72) ** 2));
    estimates.push({ palmY: finger.y + dy - anatomy.knuckle * W, weight: 1 });
  });
  const totalWeight = estimates.reduce((total, entry) => total + entry.weight, 0);
  const meanPalmY = estimates.reduce((total, entry) => total + entry.palmY * entry.weight, 0) / totalWeight;
  // A stretched hand moves in toward the keys and curls its middle fingers,
  // rather than bending the outer fingers sideways from far away.
  const nearestPalmY = Math.min(...estimates.map((entry) => entry.palmY));
  const naturalPalmY = meanPalmY * 0.5 + nearestPalmY * 0.5;
  const palmY = naturalPalmY - (Number(palmHeight) - 44) * 0.55;

  const local = (x, y) => ({ x: centerX + direction * x, y });
  const half = palmWidth / 2;
  const wristY = palmY + W * 5;
  const wristThumbCorner = local(-half - W * 0.1, wristY);
  let thumbJoint = null;
  let thumbAxis = null;
  if (thumb) {
    // The thumb's metacarpal lies inside the palm (the thenar bulge), so the
    // visible thumb starts at the joint on the palm's edge and points at the key.
    // Aim the thumb ray at the middle of the wrist rather than its corner, so
    // the thumb sits at a natural angle to the fingers instead of parallel.
    const wristTarget = local(-half * 0.2, wristY + W * 0.4);
    const toWrist = { x: wristTarget.x - thumb.x, y: wristTarget.y - thumb.y };
    const distance = Math.hypot(toWrist.x, toWrist.y) || 1;
    const unit = { x: toWrist.x / distance, y: toWrist.y / distance };
    let length = REFERENCE_FINGER_LENGTH * FINGER_ANATOMY[1].length * reachScale;
    const lowestJointY = palmY + W * 0.45;
    if (unit.y > 0 && thumb.y + unit.y * length < lowestJointY) length = (lowestJointY - thumb.y) / unit.y;
    length = Math.min(length, distance * 0.62);
    thumbJoint = { x: thumb.x + unit.x * length, y: thumb.y + unit.y * length };
    thumbAxis = unit;
  }

  const fingers = fingerTargets.map((finger) => {
    const anatomy = finger.anatomy;
    const knuckle = finger.finger === 1
      ? thumbJoint
      : { x: centerX + direction * knuckleOffsets[finger.finger], y: palmY + anatomy.knuckle * W };
    const shape = buildFinger({
      knuckle,
      tip: { x: finger.x, y: finger.y },
      finger: finger.finger,
      anatomy,
      width: W * anatomy.width,
      curveAmount,
      direction,
    });
    return { ...finger, knuckle, ...shape };
  });

  // Back of the hand: scalloped knuckle line, hypothenar bulge on the pinky
  // side, thenar swell where the thumb leaves the palm, wrist running off-canvas.
  const knuckleY = (finger) => palmY + FINGER_ANATOMY[finger].knuckle * W;
  const top = [];
  [2, 3, 4, 5].forEach((finger, index) => {
    top.push(local(knuckleOffsets[finger], knuckleY(finger) - W * 0.08));
    if (finger !== 5) {
      const next = [2, 3, 4, 5][index + 1];
      const notchX = (knuckleOffsets[finger] + knuckleOffsets[next]) / 2;
      top.push(local(notchX, Math.max(knuckleY(finger), knuckleY(next)) + W * 0.14));
    }
  });
  const indexWeb = local(-half + W * 0.06, knuckleY(2) + W * 0.5);
  let thumbSide;
  if (thumbJoint) {
    // Thenar bulge from the wrist out to the thumb joint, across the base of
    // the thumb, then the web curving back in to the index knuckle.
    const palmCenter = local(0, palmY + W * 2);
    let outward = { x: -thumbAxis.y, y: thumbAxis.x };
    if (outward.x * (thumbJoint.x - palmCenter.x) + outward.y * (thumbJoint.y - palmCenter.y) < 0) {
      outward = { x: -outward.x, y: -outward.y };
    }
    const along = { x: thumbJoint.x - wristThumbCorner.x, y: thumbJoint.y - wristThumbCorner.y };
    const thenar = {
      x: wristThumbCorner.x + along.x * 0.45 + outward.x * W * 0.38,
      y: wristThumbCorner.y + along.y * 0.45 + outward.y * W * 0.38,
    };
    // This point sits under the thumb, so the thumb's own outline forms the edge.
    const underThumb = { x: thumbJoint.x + thumbAxis.x * W * 0.3, y: thumbJoint.y + thumbAxis.y * W * 0.3 };
    const toCenter = { x: palmCenter.x - (underThumb.x + indexWeb.x) / 2, y: palmCenter.y - (underThumb.y + indexWeb.y) / 2 };
    const toCenterLength = Math.hypot(toCenter.x, toCenter.y) || 1;
    const web = {
      x: (underThumb.x + indexWeb.x) / 2 + (toCenter.x / toCenterLength) * W * 0.18,
      y: (underThumb.y + indexWeb.y) / 2 + (toCenter.y / toCenterLength) * W * 0.18,
    };
    thumbSide = [thenar, underThumb, web];
  } else {
    thumbSide = [
      local(-half - W * 0.5, palmY + W * 3.3),
      local(-half - W * 0.55, palmY + W * 2.1),
      local(-half - W * 0.28, palmY + W * 1.15),
    ];
  }
  const palmPoints = [
    ...top,
    local(half + W * 0.12, knuckleY(5) + W * 0.5),
    local(half + W * 0.26, palmY + W * 2.5),
    local(half + W * 0.1, wristY),
    local(0, wristY + W * 0.15),
    wristThumbCorner,
    ...thumbSide,
    indexWeb,
  ];
  const palmPath = smoothClosedPath(palmPoints);

  return { fingers, palmPath, centerX, palmY, palmWidth, direction };
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

  const geometry = keyboardGeometry(fingers);
  const activeSet = new Set([...activeMidis].map(Number));
  const fingerByMidi = new Map(fingers.map((finger) => [noteToMidi(finger.note), finger]));
  const assignedSet = new Set(fingerByMidi.keys());
  const fingerTargets = fingers.map((finger) => {
    const midi = noteToMidi(finger.note);
    const key = geometry.keyByMidi.get(midi);
    const anatomy = FINGER_ANATOMY[finger.finger];
    const targetY = key.y + (isBlackNote(finger.note) ? anatomy.blackDepth : anatomy.whiteDepth);
    return { ...finger, anatomy, midi, x: key.centerX, y: targetY };
  });

  const layout = handLayout({ hand, fingerTargets, weight, curve, palmHeight });
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

  const badgeFor = (finger) => ({
    x: finger.tipEnd.x + finger.tangent.x * 17,
    y: finger.tipEnd.y + finger.tangent.y * 17,
  });

  const guideLines = showGuides
    ? layout.fingers
        .filter((finger) => finger.finger === 1 || finger.finger === 5)
        .map((finger) => {
          const badge = badgeFor(finger);
          return `
          <g class="anchor-guide">
            <line x1="${fmt(finger.x)}" y1="${fmt(badge.y - 14)}" x2="${fmt(finger.x)}" y2="39" />
            <text x="${fmt(finger.x)}" y="31" text-anchor="middle">${finger.finger === 1 ? "THUMB" : "PINKY"}</text>
          </g>`;
        })
        .join("")
    : "";

  const halos = layout.fingers.map((finger) => `
      <circle class="touch-halo ${activeSet.has(finger.midi) ? "is-active" : ""}" data-finger="${finger.finger}" cx="${fmt(finger.x)}" cy="${fmt(finger.y)}" r="${fmt(finger.tipHalf * 1.5)}" />`).join("");

  const fingerShapes = layout.fingers.map((finger) => `
        <path class="finger-fill" data-finger="${finger.finger}" d="${finger.outline}" />`).join("");

  const fingerDetails = layout.fingers.map((finger) => `
      <g class="hand-finger ${activeSet.has(finger.midi) ? "is-active" : ""}" data-finger="${finger.finger}">
        ${finger.creases.map((crease) => `<path class="finger-crease" d="${crease}" />`).join("")}
        <ellipse class="fingernail" cx="${fmt(finger.nail.cx)}" cy="${fmt(finger.nail.cy)}" rx="${fmt(finger.nail.rx)}" ry="${fmt(finger.nail.ry)}" transform="rotate(${fmt(finger.nail.angle)} ${fmt(finger.nail.cx)} ${fmt(finger.nail.cy)})" />
      </g>`).join("");

  const badges = layout.fingers.map((finger) => {
    const badge = badgeFor(finger);
    return `
      <g class="finger-badge" data-finger="${finger.finger}">
        <circle cx="${fmt(badge.x)}" cy="${fmt(badge.y)}" r="9.5" />
        <text class="finger-number" x="${fmt(badge.x)}" y="${fmt(badge.y + 4)}" text-anchor="middle">${finger.finger}</text>
      </g>`;
  }).join("");

  const handLabel = hand === "right" ? "RIGHT HAND" : "LEFT HAND";
  const playerViewLabel = `PLAYER VIEW · ${handLabel}`;
  const glowX = layout.centerX;
  const glowY = layout.palmY + Number(weight) * 0.6;

  return `
    <svg class="hand-keyboard" xmlns="${SVG_NS}" viewBox="0 0 1040 430" role="img" aria-label="${handLabel.toLowerCase()} positioned on a piano keyboard">
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
          .finger-badge circle { fill: var(--paper); stroke: var(--clay); stroke-width: 1.2; }
          .finger-number { fill: var(--clay-deep); font-family: Baskerville, serif; font-size: 12px; font-style: italic; font-weight: 700; }
          .touch-halo { fill: transparent; }
          .touch-halo.is-active { fill: #e9a63a80; filter: url(#active-glow); }
        </style>
        <radialGradient id="hand-skin" gradientUnits="userSpaceOnUse" cx="${fmt(glowX)}" cy="${fmt(glowY)}" r="${fmt(layout.palmWidth * 2.1)}">
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

      <text class="diagram-label" x="54" y="414">${playerViewLabel}</text>
      <text class="diagram-hint" x="986" y="414" text-anchor="end">WRIST BELOW · KEYS ABOVE</text>

      <g class="keyboard-shadow">
        <rect x="${geometry.keyboardX - 8}" y="${geometry.keyboardY - 8}" width="${geometry.keyboardWidth + 16}" height="${geometry.whiteHeight + 16}" rx="9" />
      </g>
      <g class="keyboard">${whiteKeys}${blackKeys}</g>

      ${guideLines}
      ${halos}

      <g class="hand" filter="url(#hand-skin-edge)">
        ${fingerShapes}
        <path class="palm" d="${layout.palmPath}" />
      </g>
      <g class="hand-detail">
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
