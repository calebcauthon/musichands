// The player as the stage draws them: a bench, a seated body in a dark suit,
// and a sleeve from each cuff back to its shoulder. Where everything sits
// comes from player-body.js; this only gives it a surface.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { BODY, seatPlayer, torsoMatrix } from "./player-body.js";
import { mat4, vec3 } from "./rig-math.js";

const SIDES = ["left", "right"];
const COLORS = { cloth: 0x0d0d10, trousers: 0x040405, cuff: 0xf2efe8, leather: 0x0b0a0a, lacquer: 0x040404, shoe: 0x050505 };
const AROUND = 40;
// A soft rectangle rather than an ellipse, the way cloth sits on a limb.
const OUTLINE = Array.from({ length: AROUND + 1 }, (_, step) => {
  const angle = (step / AROUND) * Math.PI * 2;
  const soften = (value) => Math.sign(value) * Math.abs(value) ** 0.8;
  return [soften(Math.cos(angle)), soften(Math.sin(angle))];
});

// Rings of the shirt cuff and of the mouth of the jacket sleeve: how far up
// the forearm from the wrist, then half the width and half the height there.
// These grow and shrink with the hand.
const CUFF = [[0.006, 0.029, 0.0215], [0.0045, 0.0335, 0.026], [0.012, 0.0345, 0.027], [0.034, 0.035, 0.0275]];
const SLEEVE_MOUTH = [[0.021, 0.03, 0.023], [0.0195, 0.0385, 0.031], [0.03, 0.04, 0.0325]];
const WRIST_TURN = 0.04; // how far up the forearm a bent wrist still turns the cloth toward the hand
// The rest of the sleeve: the share of the way up the forearm, then up the
// upper arm, and the half width and height there.
const FOREARM = [[0.38, 0.0435, 0.037], [0.62, 0.048, 0.043]];
const UPPER_ARM = [[0.45, 0.056, 0.055], [0.8, 0.059, 0.059], [1, 0.06, 0.06]];
const ELBOW = { round: 0.055, wide: 0.053, tall: 0.05 };
// The sleeve closes over the top of the shoulder: how far past the joint, and the radius there.
const SHOULDER_CAP = [[0.015, 0.055], [0.028, 0.04], [0.035, 0.021], [0.037, 0.002]];
const JOINT_STEPS = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];
const SLEEVE_ROWS = SLEEVE_MOUTH.length + FOREARM.length + JOINT_STEPS.length + 2 + UPPER_ARM.length + SHOULDER_CAP.length;

// Rings up the torso: height above the hips, half the width, half the depth,
// and how far behind the spine the ring is centred. It closes at the collar:
// the player is a suit with nobody's face.
const TORSO = [
  [-0.095, 0.166, 0.118, 0.012],
  [-0.03, 0.176, 0.126, 0.012],
  [0.08, 0.166, 0.116, 0.004],
  [0.19, 0.154, 0.106, 0],
  [0.31, 0.166, 0.116, -0.004],
  [0.41, 0.172, 0.118, -0.004],
  [0.46, 0.186, 0.11, 0],
  [0.5, 0.205, 0.098, 0.004],
  [0.528, 0.2, 0.082, 0.008],
  [0.545, 0.16, 0.07, 0.01],
  [0.558, 0.1, 0.064, 0.012],
  [0.568, 0.06, 0.055, 0.012],
  [0.574, 0.003, 0.003, 0.012],
];
// A right leg, hip to knee to ankle, and the half width and height of the
// trouser leg at the hip, the knee and the hem.
const LEG = { hip: [0.095, -0.165, 0.455], knee: [0.13, -0.215, 0.035], ankle: [0.135, -0.66, 0.045], round: 0.07 };
const LEG_RINGS = { hip: [0.088, 0.082], thigh: [0.076, 0.072], knee: [0.062, 0.06], calf: [0.054, 0.054], hem: [0.043, 0.045] };
// A right shoe from heel to toe: z, the height of its middle, half width, half height.
const SHOE = [
  [0.088, -0.712, 0.006, 0.006],
  [0.08, -0.702, 0.034, 0.031],
  [0.03, -0.7, 0.041, 0.034],
  [-0.05, -0.705, 0.047, 0.03],
  [-0.12, -0.711, 0.045, 0.024],
  [-0.168, -0.718, 0.032, 0.017],
  [-0.182, -0.722, 0.004, 0.004],
];

// A skin stretched over a row of rings, each { center, across, up, wide, tall }.
class Loft {
  constructor(rows, material) {
    const indices = [];
    for (let row = 0; row < rows - 1; row += 1) {
      for (let step = 0; step < AROUND; step += 1) {
        const a = row * (AROUND + 1) + step;
        const b = a + AROUND + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    this.positions = new Float32Array(rows * (AROUND + 1) * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setIndex(indices);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // The rings move every frame, so there is no fixed volume to test against the view.
    this.mesh.frustumCulled = false;
  }

  shape(rings) {
    const positions = this.positions;
    let at = 0;
    for (const { center, across, up, wide, tall } of rings) {
      for (const [x, y] of OUTLINE) {
        positions[at] = center[0] + across[0] * x * wide + up[0] * y * tall;
        positions[at + 1] = center[1] + across[1] * x * wide + up[1] * y * tall;
        positions[at + 2] = center[2] + across[2] * x * wide + up[2] * y * tall;
        at += 3;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    // Each ring starts and ends on the same point; give the two one normal so no seam shows.
    const normal = this.geometry.attributes.normal;
    for (let first = 0; first < normal.count; first += AROUND + 1) {
      const last = first + AROUND;
      const joined = vec3.normalize([
        normal.getX(first) + normal.getX(last),
        normal.getY(first) + normal.getY(last),
        normal.getZ(first) + normal.getZ(last),
      ]);
      normal.setXYZ(first, ...joined);
      normal.setXYZ(last, ...joined);
    }
    return this;
  }
}

// Rings for stations along a path, each { point, tangent, wide, tall }. The
// first ring's top faces `up`, and the rest follow it round without twisting.
function ringsAlong(stations, up) {
  return stations.map(({ point, tangent, wide, tall }) => {
    up = vec3.normalize(vec3.sub(up, vec3.scale(tangent, vec3.dot(up, tangent))));
    return { center: point, across: vec3.cross(up, tangent), up, wide, tall };
  });
}

// Stations round a joint between two straight bones, from `round` before it to `round` after.
function roundJoint(joint, before, after, round, wide, tall) {
  const from = vec3.sub(joint, vec3.scale(before, round));
  const to = vec3.add(joint, vec3.scale(after, round));
  return JOINT_STEPS.map((t) => ({
    point: vec3.add(vec3.add(vec3.scale(from, (1 - t) ** 2), vec3.scale(joint, 2 * t * (1 - t))), vec3.scale(to, t * t)),
    tangent: vec3.normalize(vec3.lerp(before, after, t)),
    wide,
    tall,
  }));
}

// Patches a material so it thins to nothing close to the lens, which may sit
// where the player's head and shoulders are.
function fading(material) {
  material.alphaHash = true;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFadePosition;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvFadePosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFadePosition;")
      .replace(
        "#include <alphatest_fragment>",
        `diffuseColor.a *= smoothstep(0.07, 0.19, distance(cameraPosition, vFadePosition));
        #include <alphatest_fragment>`,
      );
  };
  return material;
}

export class PlayerFigure {
  constructor() {
    this.group = new THREE.Group();
    this.parts = []; // { mesh, full, light }
    this.light = false;

    const pair = (full, light) => ({ full: fading(full), light: fading(light) });
    const cloth = (side) =>
      pair(
        new THREE.MeshPhysicalMaterial({ color: COLORS.cloth, roughness: 0.9, sheen: 1, sheenColor: new THREE.Color(0x3a3a48), sheenRoughness: 0.5, side }),
        new THREE.MeshLambertMaterial({ color: COLORS.cloth, side }),
      );
    // Sleeves show their inside at the cuff. The body does not, so a lens inside it sees out.
    const sleeve = cloth(THREE.DoubleSide);
    const suit = cloth(THREE.FrontSide);
    // Legs sit in the dark under the keyboard, and stay out of the picture's way.
    const trousers = { full: new THREE.MeshStandardMaterial({ color: COLORS.trousers, roughness: 1 }), light: new THREE.MeshLambertMaterial({ color: COLORS.trousers }) };
    const cuff = pair(
      new THREE.MeshPhysicalMaterial({ color: COLORS.cuff, roughness: 0.85, sheen: 0.4, sheenRoughness: 0.8, side: THREE.DoubleSide }),
      new THREE.MeshLambertMaterial({ color: COLORS.cuff, side: THREE.DoubleSide }),
    );
    const shoe = { full: new THREE.MeshPhysicalMaterial({ color: COLORS.shoe, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.3 }), light: new THREE.MeshLambertMaterial({ color: COLORS.shoe }) };
    const leather = { full: new THREE.MeshPhysicalMaterial({ color: COLORS.leather, roughness: 0.62, sheen: 0.3, sheenRoughness: 0.6 }), light: new THREE.MeshLambertMaterial({ color: COLORS.leather }) };
    const lacquer = { full: new THREE.MeshPhysicalMaterial({ color: COLORS.lacquer, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.28 }), light: new THREE.MeshLambertMaterial({ color: COLORS.lacquer }) };

    this.buildBench(leather, lacquer);
    this.torso = this.add(new Loft(TORSO.length, suit.full).shape(TORSO.map(([height, wide, tall, back]) => ({ center: [0, height, back], across: [1, 0, 0], up: [0, 0, -1], wide, tall }))).mesh, suit);
    this.torso.matrixAutoUpdate = false;
    for (const sign of [-1, 1]) this.buildLeg(sign, trousers, shoe);
    this.arms = {};
    for (const side of SIDES) {
      const arm = { cuff: new Loft(CUFF.length, cuff.full), sleeve: new Loft(SLEEVE_ROWS, sleeve.full) };
      this.add(arm.cuff.mesh, cuff);
      this.add(arm.sleeve.mesh, sleeve);
      this.arms[side] = arm;
    }
    this.pose({});
  }

  add(mesh, materials) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.parts.push({ mesh, ...materials });
    this.group.add(mesh);
    return mesh;
  }

  buildBench(leather, lacquer) {
    const { top, width, depth, z } = BODY.bench;
    const cushion = this.add(new THREE.Mesh(new RoundedBoxGeometry(width, 0.07, depth, 4, 0.022), leather.full), leather);
    cushion.position.set(0, top - 0.035, z);
    const frame = this.add(new THREE.Mesh(new THREE.BoxGeometry(width - 0.05, 0.06, depth - 0.05), lacquer.full), lacquer);
    frame.position.set(0, top - 0.1, z);
    const legTop = top - 0.13;
    for (const x of [-1, 1]) {
      for (const back of [-1, 1]) {
        const leg = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.045, legTop - BODY.floor, 0.045), lacquer.full), lacquer);
        leg.position.set(x * (width / 2 - 0.05), (legTop + BODY.floor) / 2, z + back * (depth / 2 - 0.05));
      }
    }
  }

  buildLeg(sign, trousers, shoe) {
    const at = ([x, y, z]) => [sign * x, y, z];
    const [hip, knee, ankle] = [at(LEG.hip), at(LEG.knee), at(LEG.ankle)];
    const thigh = vec3.normalize(vec3.sub(knee, hip));
    const shin = vec3.normalize(vec3.sub(ankle, knee));
    const station = (point, tangent, [wide, tall]) => ({ point, tangent, wide, tall });
    const stations = [
      station(hip, thigh, LEG_RINGS.hip),
      station(vec3.lerp(hip, knee, 0.5), thigh, LEG_RINGS.thigh),
      station(vec3.sub(knee, vec3.scale(thigh, LEG.round)), thigh, LEG_RINGS.knee),
      ...roundJoint(knee, thigh, shin, LEG.round, ...LEG_RINGS.knee),
      station(vec3.add(knee, vec3.scale(shin, LEG.round)), shin, LEG_RINGS.knee),
      station(vec3.lerp(knee, ankle, 0.45), shin, LEG_RINGS.calf),
      station(ankle, shin, LEG_RINGS.hem),
    ];
    this.add(new Loft(stations.length, trousers.full).shape(ringsAlong(stations, [0, 1, 0])).mesh, trousers);
    const rings = SHOE.map(([z, height, wide, tall]) => ({ center: [sign * LEG.ankle[0], height, z], across: [-1, 0, 0], up: [0, 1, 0], wide, tall }));
    this.add(new Loft(rings.length, shoe.full).shape(rings).mesh, shoe);
  }

  // Light detail swaps every surface for a plain, cheap one.
  setLight(light) {
    this.light = Boolean(light);
    for (const part of this.parts) part.mesh.material = this.light ? part.light : part.full;
  }

  // Seats the player for the hands as they are now.
  // hands: { left, right }, each { matrix, scale, swing }: the hand's place in
  // the world, how big it is, and how far its elbow is swung out. A missing
  // hand leaves that arm undrawn.
  pose(hands) {
    const wrists = {};
    const swings = {};
    for (const side of SIDES) {
      if (!hands[side]) continue;
      wrists[side] = mat4.position(hands[side].matrix);
      swings[side] = hands[side].swing ?? 0;
    }
    this.seated = seatPlayer(wrists, swings);
    const torso = torsoMatrix(this.seated.lean);
    this.torso.matrix.fromArray(torso);
    this.torso.matrixWorldNeedsUpdate = true;
    for (const side of SIDES) {
      const arm = this.arms[side];
      const drawn = Boolean(hands[side]);
      arm.cuff.mesh.visible = drawn;
      arm.sleeve.mesh.visible = drawn;
      if (drawn) this.shapeArm(arm, this.seated.arms[side], hands[side]);
    }
  }

  shapeArm(arm, { wrist, elbow, shoulder }, { matrix, scale }) {
    const fore = vec3.normalize(vec3.sub(elbow, wrist));
    const upper = vec3.normalize(vec3.sub(shoulder, elbow));
    const foreLength = vec3.distance(wrist, elbow);
    const upperLength = vec3.distance(elbow, shoulder);
    const backOfHand = vec3.normalize(mat4.axisY(matrix));
    const heelOfHand = vec3.normalize(mat4.axisZ(matrix));
    const alongFore = (distance) => vec3.add(wrist, vec3.scale(fore, distance));
    const alongUpper = (distance) => vec3.add(elbow, vec3.scale(upper, distance));
    // At the wrist the cloth sits halfway between the hand's line and the
    // forearm's, so a bent wrist stays inside its cuff.
    const nearWrist = ([distance, wide, tall]) => {
      const tangent = vec3.normalize(vec3.lerp(heelOfHand, fore, 0.5 + 0.5 * Math.min(1, distance / WRIST_TURN)));
      return { point: vec3.add(wrist, vec3.scale(tangent, distance * scale)), tangent, wide: wide * scale, tall: tall * scale };
    };

    arm.cuff.shape(ringsAlong(CUFF.map(nearWrist), backOfHand));
    const round = Math.min(ELBOW.round, foreLength * 0.4, upperLength * 0.4);
    // The sleeve is the hand's size at the cuff and the body's by the elbow.
    const fit = (share) => scale + (1 - scale) * Math.min(1, share / FOREARM[0][0]);
    const stations = [
      ...SLEEVE_MOUTH.map(nearWrist),
      ...FOREARM.map(([share, wide, tall]) => ({ point: alongFore(Math.max(share * foreLength, 0.04 * scale)), tangent: fore, wide: wide * fit(share), tall: tall * fit(share) })),
      { point: alongFore(foreLength - round), tangent: fore, wide: ELBOW.wide - 0.002, tall: ELBOW.tall - 0.003 },
      ...roundJoint(elbow, fore, upper, round, ELBOW.wide, ELBOW.tall),
      { point: alongUpper(round), tangent: upper, wide: ELBOW.wide + 0.001, tall: ELBOW.tall + 0.002 },
      ...UPPER_ARM.map(([share, wide, tall]) => ({ point: alongUpper(round + (upperLength - round) * share), tangent: upper, wide, tall })),
      ...SHOULDER_CAP.map(([past, radius]) => ({ point: alongUpper(upperLength + past), tangent: upper, wide: radius, tall: radius })),
    ];
    arm.sleeve.shape(ringsAlong(stations, backOfHand));
  }
}
