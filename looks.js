// How the stage looks: the piano, the player and the place, each chosen from
// a set of named looks. A workspace's `look` names one of each; the stage
// (hand-stage.js, player-figure.js, stage-scenes.js) reads the specs here and
// dresses itself accordingly. To add a look, add an entry to the right set;
// nothing else needs to know. Colours are hex numbers, sizes are metres.
//
// This file has no three.js in it, so the server and the tests can read it too.

export const LOOKS = {
  // The instrument: its lacquer, its keys, the felt behind them, and the colour of the fallboard that mirrors the hands.
  piano: {
    ebony: { label: "Ebony grand", lacquer: 0x040404, ivory: 0xe9e2d3, ebony: 0x0c0b0b, felt: 0x6d1320, mirror: 0x0a0a0a },
    white: { label: "White grand", lacquer: 0xf3eee4, ivory: 0xefe9dc, ebony: 0x151313, felt: 0x8a2436, mirror: 0xe9e5dd },
    rosewood: { label: "Rosewood grand", lacquer: 0x4a1f12, ivory: 0xece3cf, ebony: 0x14100e, felt: 0x2f4a2a, mirror: 0x3a170d },
    crimson: { label: "Crimson grand", lacquer: 0x7a1220, ivory: 0xf1eadb, ebony: 0x0d0a0a, felt: 0x2b1a3a, mirror: 0x5a0d16 },
  },

  // The player's frame: how broad and how long, and how big a hand.
  // `torso` and `limbs` scale the figure's widths; `hand` scales the hands.
  build: {
    man: { label: "Man", shoulder: 0.185, spine: 0.49, upperArm: 0.3, forearm: 0.265, torso: 1, limbs: 1, hand: 1 },
    woman: { label: "Woman", shoulder: 0.165, spine: 0.465, upperArm: 0.28, forearm: 0.25, torso: 0.88, limbs: 0.86, hand: 0.92 },
  },

  // Skin: the colour, the warm light that scatters through it, the flush at
  // the knuckles and fingertips, and the nails.
  skin: {
    fair: { label: "Fair", color: 0xd8a07c, sheen: 0xff7a52, glow: 0x5a1408, flush: [1.0, 0.8, 0.77], nail: [0.78, 0.5, 0.45], nailTip: [0.9, 0.8, 0.74] },
    olive: { label: "Olive", color: 0xb8865a, sheen: 0xe8804e, glow: 0x4a1406, flush: [1.0, 0.84, 0.78], nail: [0.72, 0.5, 0.42], nailTip: [0.88, 0.78, 0.7] },
    brown: { label: "Brown", color: 0x7e4f30, sheen: 0xb85a3a, glow: 0x30100a, flush: [1.0, 0.86, 0.82], nail: [0.6, 0.42, 0.36], nailTip: [0.84, 0.74, 0.68] },
    dark: { label: "Dark", color: 0x4a2c1c, sheen: 0x8a4a34, glow: 0x1e0a06, flush: [1.0, 0.88, 0.84], nail: [0.5, 0.36, 0.32], nailTip: [0.8, 0.7, 0.66] },
  },

  // Clothes: the jacket (with its sheen), the shirt cuff, the trousers and
  // the shoes. `dots` sprinkles the jacket with spots of another colour.
  outfit: {
    suit: { label: "Dark suit", cloth: 0x0d0d10, sheen: 0x3a3a48, cuff: 0xf2efe8, trousers: 0x040405, shoes: 0x050505, shine: 0.5 },
    tuxedo: { label: "Tuxedo", cloth: 0x08080a, sheen: 0x505060, cuff: 0xfaf7f0, trousers: 0x08080a, shoes: 0x0a0a0a, shine: 0.8 },
    linen: { label: "Linen jacket", cloth: 0xd9cdb4, sheen: 0xf0e8d8, cuff: 0xfaf6ee, trousers: 0x8a7f6a, shoes: 0x5a3a22, shine: 0.2 },
    clown: { label: "Clown", cloth: 0xd8342a, sheen: 0xffb0a0, cuff: 0xfff4c0, trousers: 0x2447c8, shoes: 0xe0b020, shine: 0.6, dots: { color: 0xffd23a, size: 0.06 } },
  },

  // Gloves cover the hands; `none` shows the skin.
  gloves: {
    none: { label: "Bare hands" },
    white: { label: "White cotton gloves", color: 0xf4f1ea, roughness: 0.95, sheen: 0.6 },
    black: { label: "Black leather gloves", color: 0x0c0a0a, roughness: 0.4, clearcoat: 0.5 },
  },

  // Where the piano stands. `set` names what stage-scenes.js builds around it.
  scene: {
    stage: { label: "Dark stage", set: "stage", background: 0x0b0806, fog: [1.6, 7], ambient: 0.14 },
    park: { label: "In the park", set: "park", background: 0xc6d9e6, fog: [14, 90], ambient: 0.55 },
    hall: { label: "Concert hall", set: "hall", background: 0x0a0705, fog: [8, 34], ambient: 0.22 },
  },
};

export const LOOK_KINDS = Object.keys(LOOKS);

export function defaultLook() {
  return { piano: "ebony", build: "man", skin: "fair", outfit: "suit", gloves: "none", scene: "stage" };
}

// Whatever was stored or sent, made into a look the stage can wear: unknown
// names fall back to the default.
export function cleanLook(value) {
  const look = defaultLook();
  if (!value || typeof value !== "object") return look;
  for (const kind of LOOK_KINDS) {
    if (typeof value[kind] === "string" && LOOKS[kind][value[kind]]) look[kind] = value[kind];
  }
  return look;
}

// The specs a look names, by kind.
export function specsFor(look) {
  const clean = cleanLook(look);
  return Object.fromEntries(LOOK_KINDS.map((kind) => [kind, { name: clean[kind], ...LOOKS[kind][clean[kind]] }]));
}
