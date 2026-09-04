import { getKeyboardWindow, isBlackNote, midiToNote, noteToMidi } from "./hand-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FINGER_ANATOMY = {
  // Lengths are normalized to the middle finger. Contact depths let a relaxed
  // hand reach farther with the long middle fingers and stay nearer with the
  // thumb and pinky while still landing on the assigned key.
  1: { length: 0.63, width: 1.12, rootY: -25, whiteDepth: 196, blackDepth: 146, nailX: 11, nailY: 7.2 },
  2: { length: 0.91, width: 0.93, rootY: -20, whiteDepth: 166, blackDepth: 116, nailX: 9.2, nailY: 7.5 },
  3: { length: 1, width: 1, rootY: -24, whiteDepth: 150, blackDepth: 100, nailX: 9.8, nailY: 8 },
  4: { length: 0.95, width: 0.91, rootY: -21, whiteDepth: 159, blackDepth: 109, nailX: 9, nailY: 7.4 },
  5: { length: 0.77, width: 0.72, rootY: -23, whiteDepth: 180, blackDepth: 130, nailX: 7.5, nailY: 6.4 },
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cubicPath(start, end, curve, hand, finger) {
  const direction = hand === "right" ? 1 : -1;
  const bend = (end.x - start.x) * 0.32 + direction * curve * 0.12;
  const deltaY = end.y - start.y;
  const approach = end.y - Math.sign(deltaY || 1) * curve;
  const outwardSwing = finger === 1 ? -direction * 27 : finger === 5 ? direction * 8 : 0;
  return [
    `M ${start.x.toFixed(1)} ${start.y.toFixed(1)}`,
    `C ${(start.x + bend + outwardSwing).toFixed(1)} ${(start.y + deltaY * 0.34).toFixed(1)},`,
    `${(end.x - bend * 0.35 + outwardSwing * 0.22).toFixed(1)} ${approach.toFixed(1)},`,
    `${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
  ].join(" ");
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

function fingerBaseOffset(hand, finger) {
  const right = { 1: -0.88, 2: -0.5, 3: -0.14, 4: 0.27, 5: 0.7 };
  const left = { 1: 0.88, 2: 0.5, 3: 0.14, 4: -0.27, 5: -0.7 };
  return (hand === "right" ? right : left)[finger];
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

  const minX = Math.min(...fingerTargets.map((finger) => finger.x));
  const maxX = Math.max(...fingerTargets.map((finger) => finger.x));
  const centerX = (minX + maxX) / 2;
  const palmWidth = Math.max(150, Math.min(250, maxX - minX + 76));
  const referenceFingerLength = 128;
  const naturalPalmY = fingerTargets.reduce(
    (total, finger) => total + finger.y + referenceFingerLength * finger.anatomy.length - finger.anatomy.rootY,
    0,
  ) / fingerTargets.length;
  const palmY = naturalPalmY - (Number(palmHeight) - 44) * 0.55;
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

  const guideLines = showGuides
    ? fingerTargets
        .filter((finger) => finger.finger === 1 || finger.finger === 5)
        .map((finger) => `
          <g class="anchor-guide">
            <line x1="${finger.x}" y1="${finger.y - 20}" x2="${finger.x}" y2="39" />
            <text x="${finger.x}" y="31" text-anchor="middle">${finger.finger === 1 ? "THUMB" : "PINKY"}</text>
          </g>`)
        .join("")
    : "";

  const fingerPaths = fingerTargets.map((finger) => {
    const baseX = centerX + fingerBaseOffset(hand, finger.finger) * palmWidth * 0.48;
    const baseY = palmY + finger.anatomy.rootY;
    const path = cubicPath(
      { x: baseX, y: baseY },
      { x: finger.x, y: finger.y },
      Number(curve) * (finger.finger === 1 ? 0.72 : finger.finger === 5 ? 0.86 : 1),
      hand,
      finger.finger,
    );
    const active = activeSet.has(finger.midi);
    const fingerWeight = Number(weight) * finger.anatomy.width;
    const creaseY = finger.y + fingerWeight * 0.72;
    return `
      <g class="hand-finger ${active ? "is-active" : ""}" data-finger="${finger.finger}">
        <circle class="touch-halo" cx="${finger.x}" cy="${finger.y}" r="${fingerWeight * 0.72}" />
        <path class="finger-outline" d="${path}" style="stroke-width:${fingerWeight + 2.4}" />
        <path class="finger-fill" d="${path}" style="stroke-width:${fingerWeight}" />
        <path class="finger-crease" d="M ${finger.x - 7} ${creaseY} Q ${finger.x} ${creaseY + 3} ${finger.x + 7} ${creaseY}" />
        <ellipse class="fingernail" cx="${finger.x}" cy="${finger.y + 1}" rx="${finger.anatomy.nailX}" ry="${finger.anatomy.nailY}" />
        <text class="finger-number" x="${finger.x}" y="${finger.y + 4}" text-anchor="middle">${finger.finger}</text>
      </g>`;
  }).join("");

  const wristLean = hand === "right" ? 8 : -8;
  const handLabel = hand === "right" ? "RIGHT HAND" : "LEFT HAND";
  const playerViewLabel = `PLAYER VIEW · ${handLabel}`;
  const palmPath = [
    `M ${centerX - palmWidth * 0.44} ${palmY - 29}`,
    `C ${centerX - palmWidth * 0.56} ${palmY - 2}, ${centerX - palmWidth * 0.48} ${palmY + 29}, ${centerX - palmWidth * 0.29} ${palmY + 43}`,
    `C ${centerX - palmWidth * 0.2} ${palmY + 49}, ${centerX - 60 + wristLean} ${palmY + 49}, ${centerX - 55 + wristLean} ${palmY + 67}`,
    `C ${centerX - 52 + wristLean} ${palmY + 80}, ${centerX - 55 + wristLean} 407, ${centerX - 51 + wristLean} 430`,
    `L ${centerX + 51 + wristLean} 430`,
    `C ${centerX + 55 + wristLean} 407, ${centerX + 52 + wristLean} ${palmY + 80}, ${centerX + 55 + wristLean} ${palmY + 67}`,
    `C ${centerX + 60 + wristLean} ${palmY + 49}, ${centerX + palmWidth * 0.2} ${palmY + 49}, ${centerX + palmWidth * 0.29} ${palmY + 43}`,
    `C ${centerX + palmWidth * 0.5} ${palmY + 28}, ${centerX + palmWidth * 0.55} ${palmY - 3}, ${centerX + palmWidth * 0.43} ${palmY - 30}`,
    `C ${centerX + palmWidth * 0.23} ${palmY - 52}, ${centerX - palmWidth * 0.2} ${palmY - 53}, ${centerX - palmWidth * 0.44} ${palmY - 29}`,
    "Z",
  ].join(" ");

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
          .key-note, .key-finger, .finger-number, .anchor-guide text { pointer-events: none; }
          .key-note { fill: var(--ink-soft); font-size: 12px; font-weight: 600; }
          .key-note--black { fill: var(--paper); font-size: 9px; }
          .key-finger { fill: var(--clay-deep); font-family: Baskerville, serif; font-size: 15px; font-style: italic; font-weight: 700; }
          .key-finger--black { fill: var(--paper); }
          .anchor-guide { pointer-events: none; }
          .anchor-guide line { stroke: var(--clay); stroke-dasharray: 3 5; stroke-width: 1; }
          .anchor-guide text { fill: var(--clay-deep); font-size: 8px; font-weight: 700; letter-spacing: 1px; }
          .palm { fill: url(#palm-skin); stroke: #bd8b73; stroke-linejoin: round; stroke-width: 1.5; }
          .palm-line, .finger-crease { fill: none; stroke: #bd8b738f; stroke-linecap: round; stroke-width: 1.35; }
          .finger-outline, .finger-fill { fill: none; stroke-linecap: round; stroke-linejoin: round; }
          .finger-outline { stroke: #bd8b73; }
          .finger-fill { stroke: url(#finger-skin); }
          .fingernail { fill: #f9dfd0; stroke: #c9927b; stroke-width: 1; }
          .finger-number { fill: #754534; font-family: Baskerville, serif; font-size: 11px; font-style: italic; font-weight: 700; }
          .touch-halo { fill: transparent; }
          .hand-finger.is-active .touch-halo { fill: #e9a63a80; filter: url(#active-glow); }
        </style>
        <linearGradient id="finger-skin" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#f8dac6" />
          <stop offset="0.54" stop-color="#f1c6aa" />
          <stop offset="1" stop-color="#e7b393" />
        </linearGradient>
        <radialGradient id="palm-skin" cx="42%" cy="28%" r="78%">
          <stop offset="0" stop-color="#f9ddca" />
          <stop offset="0.62" stop-color="#f0c4a7" />
          <stop offset="1" stop-color="#e6b18f" />
        </radialGradient>
        <filter id="hand-shadow" x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="7" stdDeviation="8" flood-color="#4d2f23" flood-opacity="0.13" />
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

      <g class="hand" filter="url(#hand-shadow)">
        ${fingerPaths}
        <path class="palm" d="${palmPath}" />
        <path class="palm-line" d="M ${centerX - palmWidth * 0.3} ${palmY - 7} Q ${centerX} ${palmY - 30} ${centerX + palmWidth * 0.31} ${palmY - 4}" />
        <path class="palm-line palm-line--life" d="M ${centerX - palmWidth * 0.31} ${palmY + 12} Q ${centerX - palmWidth * 0.1} ${palmY + 30} ${centerX + palmWidth * 0.13} ${palmY + 20}" />
      </g>
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
