// The 3D stage: a piano keyboard and the player's two hands, lit and filmed.
//
// Hands are a rigged mesh posed by hand-rig.js, so bones keep their lengths
// and every move between positions is a real joint rotation. Each hand is on
// the end of an arm from the seated player's shoulder (player-figure.js), and
// rests on the player's lap when it has nothing to play.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { clone as cloneRigged } from "three/addons/utils/SkeletonUtils.js";
import { cleanView, DRAG_THRESHOLD, dragOrbit, framingDistance, orbitPosition, readView, sameView, ZOOM_STEP, zoomView } from "./camera-orbit.js";
import { dueForCut, readShots, ShotList, STARTER_SHOTS } from "./camera-shots.js";
import { FINGER_JOINTS, readSkeleton } from "./glb-skeleton.js";
import { noteToMidi } from "./hand-model.js";
import { blendPose, createRig, elbowSwing, lapPose, poseMatrices, solvePose } from "./hand-rig.js";
import { KEYBOARD, KEYS, keyFor } from "./piano-geometry.js";
import { PlayerFigure } from "./player-figure.js";
import { mat4 } from "./rig-math.js";
import { advanceSegments } from "./pose-timeline.js";

const HAND_MODEL_URL = new URL("./assets/hand-right.glb", import.meta.url);
const SIDES = ["left", "right"];
const COLORS = {
  backdrop: 0x0b0806,
  ivory: 0xe9e2d3,
  ivoryHeld: 0xe8c28e,
  ebony: 0x0c0b0b,
  ebonyHeld: 0x5a3220,
  gold: 0xf0a63a,
  lacquer: 0x040404,
  felt: 0x6d1320,
  skin: 0xd8a07c,
};
const KEY_LAG = 30; // ms between a finger starting down and its key following
const KEY_FALL = 25; // ms for a key to reach the bottom, where a piano sounds
const PRESS = 95; // ms for a lifted finger to come down
const LAP = { duration: 520, arc: 0.095 }; // ms between the lap and the keys, and how high the hand lifts to clear their front edge
const FARTHEST = 1.7; // how many times its starting distance the camera may back away when turned
const DRIFT = { turn: 1.1, push: 0.012 }; // degrees and share of zoom gained each second within a shot
const SHOTS_KEY = "musichands-shots";
const QUALITY_KEY = "musichands-quality";
// How much work each frame is allowed: the lens and bloom passes, the size of
// the shadow map, how many device pixels are drawn, and how often.
export const QUALITY = {
  full: { label: "Full", pixelRatio: 2, samples: 4, lens: true, bloom: true, shadows: true, softShadows: true, shadowMap: 2048, frameCap: 0 },
  balanced: { label: "Balanced", pixelRatio: 1.25, samples: 2, lens: false, bloom: true, shadows: true, softShadows: false, shadowMap: 1024, frameCap: 0 },
  light: { label: "Light", pixelRatio: 0.75, samples: 0, lens: false, bloom: false, shadows: false, softShadows: false, shadowMap: 512, frameCap: 30 },
};
const QUALITY_ORDER = ["full", "balanced", "light"];
const SLOW_FRAME = 40; // ms; frames slower than this for a while mean the level is too much for this machine
const SLOW_FRAMES = 45;

export function readQuality(text) {
  return QUALITY[text] ? text : null;
}
const AUTO_CUT_KEY = "musichands-auto-cut";
const CAMERA = { fov: 27, elevation: 72, target: [0.018, -0.002], depth: 0.275, minWidth: 0.5, margin: 0.13 };

// The last pass: darkened corners and a little grain, as from a lens and film.
const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.62 }, uGrain: { value: 0.028 } },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uGrain;
    varying vec2 vUv;
    float grain(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 centered = (vUv - 0.5) * vec2(1.0, 0.82);
      float falloff = smoothstep(0.28, 0.78, length(centered));
      color.rgb *= 1.0 - falloff * uVignette;
      color.rgb += (grain(gl_FragCoord.xy) - 0.5) * uGrain;
      gl_FragColor = color;
    }`,
};

let handAsset = null;
function loadHandAsset() {
  handAsset ??= (async () => {
    const response = await fetch(HAND_MODEL_URL);
    if (!response.ok) throw new Error(`Could not load the hand model (${response.status})`);
    const buffer = await response.arrayBuffer();
    const rig = createRig(readSkeleton(buffer));
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    return { rig, scene: gltf.scene };
  })();
  return handAsset;
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeIn = (t) => t * t;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function mirrorKey(key) {
  return {
    ...key,
    x: -key.x,
    xMin: -key.xMax,
    xMax: -key.xMin,
    stripMin: key.black ? undefined : -key.stripMax,
    stripMax: key.black ? undefined : -key.stripMin,
  };
}

// Skin, shaded per pixel in the hand's rest space so detail stays put as the
// joints move: fingernails, flushed knuckles and fingertips, wrinkles over the
// finger joints, and tendons fanning across the back of the hand.
function createSkinMaterial(rig) {
  const material = new THREE.MeshPhysicalMaterial({
    color: COLORS.skin,
    roughness: 0.52,
    metalness: 0,
    sheen: 0.25,
    sheenColor: new THREE.Color(0xff7a52),
    sheenRoughness: 0.5,
    clearcoat: 0.12,
    clearcoatRoughness: 0.55,
    // Light that has scattered through skin keeps shadows warm instead of grey.
    emissive: new THREE.Color(0x5a1408),
    emissiveIntensity: 0.1,
  });
  const inModel = (matrix) => mat4.multiply(rig.wrist, matrix);
  const frameOf = (name) => new THREE.Matrix4().fromArray(inModel(rig.rest[name])).invert();
  const nailFrames = [1, 2, 3, 4, 5].map((finger) => frameOf(FINGER_JOINTS[finger].at(-1)));
  // x: half width, y: how far behind the tip joint the nail starts, z: how far ahead it ends.
  const nailSizes = [
    new THREE.Vector3(0.0066, 0.0075, 0.0078),
    new THREE.Vector3(0.0051, 0.006, 0.0088),
    new THREE.Vector3(0.0053, 0.006, 0.0098),
    new THREE.Vector3(0.005, 0.0058, 0.0092),
    new THREE.Vector3(0.0042, 0.0052, 0.0076),
  ];
  const flush = [];
  const wrinkleFrames = [];
  const tendons = [];
  for (const finger of [1, 2, 3, 4, 5]) {
    const names = FINGER_JOINTS[finger];
    const at = (name, radius) => new THREE.Vector4(...mat4.position(inModel(rig.rest[name])), radius);
    flush.push(at(names.at(-1), 0.016), at(names[2], 0.013), at(names[1], 0.017));
    // Wrinkles sit over the two joints of each finger that bend the most.
    wrinkleFrames.push(frameOf(names.at(-3)), frameOf(names.at(-2)));
    if (finger !== 1) {
      const knuckle = mat4.position(rig.rest[names[1]]);
      tendons.push(new THREE.Vector4(knuckle[0], knuckle[2], knuckle[0] * 0.3 + 0.002, -0.012));
    }
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNailFrame = { value: nailFrames };
    shader.uniforms.uNailSize = { value: nailSizes };
    shader.uniforms.uFlush = { value: flush };
    shader.uniforms.uWrinkleFrame = { value: wrinkleFrames };
    shader.uniforms.uTendon = { value: tendons };
    shader.uniforms.uWristFrame = { value: new THREE.Matrix4().fromArray(rig.wristInverse) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRestPosition;\nvarying vec3 vRestNormal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRestPosition = position;\nvRestNormal = normal;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vRestPosition;
        varying vec3 vRestNormal;
        uniform mat4 uNailFrame[5];
        uniform vec3 uNailSize[5];
        uniform vec4 uFlush[15];
        uniform mat4 uWrinkleFrame[10];
        uniform vec4 uTendon[4];
        uniform mat4 uWristFrame;
        float nailMask;
        float nailTip;
        float nailEdge;
        float creaseMask;

        float skinHash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float skinNoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(skinHash(i), skinHash(i + vec3(1, 0, 0)), f.x), mix(skinHash(i + vec3(0, 1, 0)), skinHash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(skinHash(i + vec3(0, 0, 1)), skinHash(i + vec3(1, 0, 1)), f.x), mix(skinHash(i + vec3(0, 1, 1)), skinHash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
        }
        // Height of the skin's fine relief, in metres.
        float skinHeight(vec3 p, vec3 n) {
          float h = (skinNoise(p * 240.0) - 0.5) * 0.00016 + (skinNoise(p * 620.0) - 0.5) * 0.00007;
          float crease = 0.0;
          for (int i = 0; i < 10; i++) {
            vec3 q = (uWrinkleFrame[i] * vec4(p, 1.0)).xyz;
            vec3 m = mat3(uWrinkleFrame[i]) * n;
            float dorsal = smoothstep(0.15, 0.6, m.y);
            float window = exp(-pow(q.z / 0.0042, 2.0)) * (1.0 - smoothstep(0.0035, 0.0085, abs(q.x)));
            float lines = 0.5 + 0.5 * sin((q.z + q.x * q.x * 16.0) * 6.2832 / 0.0023);
            crease = max(crease, dorsal * window * lines);
          }
          creaseMask = crease;
          h -= crease * 0.00026;
          vec3 w = (uWristFrame * vec4(p, 1.0)).xyz;
          vec3 wn = mat3(uWristFrame) * n;
          float back = smoothstep(0.35, 0.8, wn.y);
          for (int i = 0; i < 4; i++) {
            vec2 a = uTendon[i].xy;
            vec2 b = uTendon[i].zw;
            vec2 ab = b - a;
            float t = clamp(dot(w.xz - a, ab) / dot(ab, ab), 0.0, 1.0);
            float d = distance(w.xz, a + ab * t);
            float fade = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.62, 0.95, t));
            h += exp(-pow(d / 0.0026, 2.0)) * 0.00055 * fade * back;
          }
          return h;
        }
        vec3 skinBump(vec3 position, vec3 surfaceNormal, vec2 slope, float facing) {
          vec3 sigmaX = dFdx(position);
          vec3 sigmaY = dFdy(position);
          vec3 r1 = cross(sigmaY, surfaceNormal);
          vec3 r2 = cross(surfaceNormal, sigmaX);
          float det = dot(sigmaX, r1) * facing;
          vec3 gradient = sign(det) * (slope.x * r1 + slope.y * r2);
          return normalize(abs(det) * surfaceNormal - gradient);
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        nailMask = 0.0;
        nailTip = 0.0;
        nailEdge = 0.0;
        for (int i = 0; i < 5; i++) {
          vec3 p = (uNailFrame[i] * vec4(vRestPosition, 1.0)).xyz;
          vec3 n = normalize(mat3(uNailFrame[i]) * vRestNormal);
          vec3 size = uNailSize[i];
          float along = (p.z + size.z) / (size.y + size.z); // 0 at the free edge, 1 at the root
          float across = abs(p.x) / size.x;
          // Narrower at the root, squarer at the free edge.
          float width = mix(1.0, 0.84, smoothstep(0.5, 1.0, along));
          float shape = pow(across / width, 3.2) + pow(abs(along * 2.0 - 1.0), 4.5);
          float top = smoothstep(0.18, 0.5, n.y) * step(0.0, p.y);
          float mask = (1.0 - smoothstep(0.84, 1.0, shape)) * top;
          nailMask = max(nailMask, mask);
          nailEdge = max(nailEdge, smoothstep(0.7, 0.95, shape) * (1.0 - smoothstep(0.95, 1.25, shape)) * top);
          nailTip = max(nailTip, mask * (1.0 - smoothstep(0.02, 0.13, along)));
          // The pale half-moon at the root of the nail.
          float moon = 1.0 - smoothstep(0.75, 1.0, length(vec2(across * 1.25, (1.0 - along) * 3.4)));
          nailTip = max(nailTip, mask * moon * 0.4);
        }
        float skinRelief = skinHeight(vRestPosition, normalize(vRestNormal));
        float flushAmount = 0.0;
        for (int i = 0; i < 15; i++) {
          float d = distance(vRestPosition, uFlush[i].xyz) / uFlush[i].w;
          flushAmount += exp(-d * d * 1.6);
        }
        flushAmount = clamp(flushAmount, 0.0, 1.0);
        float mottle = skinNoise(vRestPosition * 95.0) * 0.6 + skinNoise(vRestPosition * 310.0) * 0.4;
        diffuseColor.rgb *= mix(vec3(0.93, 0.95, 0.97), vec3(1.04, 1.0, 0.97), mottle);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.0, 0.8, 0.77), flushAmount * 0.6);
        diffuseColor.rgb *= 1.0 - creaseMask * 0.14;
        // Skin darkens in the fold around the nail.
        diffuseColor.rgb *= 1.0 - nailEdge * 0.3;
        vec3 nailColor = mix(vec3(0.78, 0.5, 0.45), vec3(0.9, 0.8, 0.74), nailTip);
        diffuseColor.rgb = mix(diffuseColor.rgb, nailColor, nailMask * 0.85);`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.3, nailMask);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        {
          float relief = skinRelief * (1.0 - nailMask) - nailEdge * 0.00022;
          normal = skinBump(-vViewPosition, normal, vec2(dFdx(relief), dFdy(relief)) * 1.6, faceDirection);
        }`,
      );
  };
  return material;
}

// Light mode deliberately avoids the physical lobes and the procedural skin
// shader above. At stage size those details cost far more than they contribute.
function createLightSkinMaterial() {
  return new THREE.MeshStandardMaterial({
    color: COLORS.skin,
    roughness: 0.58,
    metalness: 0,
    emissive: new THREE.Color(0x5a1408),
    emissiveIntensity: 0.08,
  });
}

class HandActor {
  constructor(side, asset, materials) {
    this.side = side;
    this.rig = asset.rig;
    this.mirror = side === "left";
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    const model = new THREE.Group();
    model.matrixAutoUpdate = false;
    model.matrix.fromArray(asset.rig.wristInverse);
    this.root.add(model);
    const scene = cloneRigged(asset.scene);
    model.add(scene);
    this.bones = new Map();
    this.skinMeshes = [];
    scene.traverse((object) => {
      if (object.isBone) {
        object.matrixAutoUpdate = false;
        this.bones.set(object.name, object);
      }
      if (object.isSkinnedMesh) {
        object.material = materials.full;
        this.skinMeshes.push(object);
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = false;
      }
    });

    this.segments = [];
    this.state = null; // { pose, scale }
    this.resting = true; // on the lap, or on its way there
    this.moved = false; // since the player's arm was last fitted to it
    this.targets = []; // fingers currently assigned, for badges
    this.balls = {};
    this.key = "";
    this.materials = materials;
  }

  setLightMaterial(light) {
    for (const mesh of this.skinMeshes) mesh.material = light ? this.materials.light : this.materials.full;
  }

  apply(state) {
    this.state = state;
    this.moved = true;
    const { hand, joints, balls, reach } = poseMatrices(this.rig, state.pose, state.scale);
    this.reach = {};
    for (const [finger, point] of Object.entries(reach)) {
      this.reach[finger] = new THREE.Vector3(this.mirror ? -point[0] : point[0], point[1], point[2]);
    }
    const flip = this.mirror ? mat4.multiply(mat4.scaling([-1, 1, 1]), hand) : hand;
    this.root.matrix.fromArray(flip);
    this.root.matrixWorldNeedsUpdate = true;
    for (const [name, matrix] of Object.entries(joints)) {
      const bone = this.bones.get(name);
      if (bone) bone.matrix.fromArray(mat4.multiply(this.rig.wrist, matrix));
    }
    this.balls = {};
    for (const [finger, ball] of Object.entries(balls)) {
      this.balls[finger] = new THREE.Vector3(this.mirror ? -ball[0] : ball[0], ball[1], ball[2]);
    }
  }

  // Advance along the queued moves. Returns true while still moving.
  step(now) {
    return advanceSegments(this.segments, now, (state) => this.apply(state), blendPose);
  }
}

export class HandStage {
  constructor(element, options = {}) {
    this.element = element;
    this.options = { interactive: false, showNotes: true, showBadges: true, curl: 0, lift: 0, scale: 1, speed: 1, snapshot: false, ...options };
    this.pace = 1; // how much faster than usual the keys are moving right now
    this.hands = {};
    this.requests = { left: null, right: null };
    this.solved = new Map();
    this.prepared = new Map();
    this.keys = new Map();
    this.held = new Set();
    this.sounding = new Set();
    this.focus = { x: 0, width: CAMERA.minWidth };
    this.view = { x: 0, width: CAMERA.minWidth };
    // The angle the camera starts from, the angle it is at, and the one it is turning toward.
    this.home = { azimuth: 0, elevation: this.options.elevation ?? CAMERA.elevation, zoom: 1 };
    // A page that keeps the camera itself (through onCamera) gets no help from local storage.
    this.kept = typeof this.options.onCamera === "function";
    this.shots = new ShotList((this.kept ? null : readShots(window.localStorage?.getItem(SHOTS_KEY))) ?? undefined);
    this.autoCut = Boolean(this.options.autoCut) && !this.kept && window.localStorage?.getItem(AUTO_CUT_KEY) === "on";
    this.rolling = false; // true while music is playing
    this.lastCut = 0;
    this.drift = { azimuth: 0, zoom: 1, turn: 1 }; // slow movement within a shot
    const stored = this.options.viewKey && !this.kept ? readView(window.localStorage?.getItem(`musichands-view-${this.options.viewKey}`)) : null;
    this.orbit = { ...(stored ?? this.home) };
    this.orbitGoal = { ...this.orbit };
    this.running = false;
    this.needsRender = true;
    this.lastTime = 0;
    this.stillOnly = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    element.classList.add("hand-stage");
    // Stills are drawn once, so they can afford the full look; a live stage
    // uses the level chosen on this machine, or a balanced one until frames
    // show what it can manage.
    this.chosenQuality = options.snapshot ? "full" : readQuality(window.localStorage?.getItem(QUALITY_KEY));
    this.quality = this.chosenQuality ?? (options.snapshot ? "full" : "balanced");
    this.slowFrames = 0;
    this.lastRendered = 0;
    // Multisampling belongs to the composer's render target. Enabling it on
    // the canvas too wastes memory and made Light's "no MSAA" claim untrue.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: Boolean(options.snapshot) });
    this.renderer.setPixelRatio(options.snapshot ? 1 : Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].pixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = QUALITY[this.quality].shadows;
    this.renderer.shadowMap.type = QUALITY[this.quality].softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "hand-stage__canvas";
    element.append(this.canvas);
    this.overlay = document.createElement("div");
    this.overlay.className = "hand-stage__overlay";
    element.append(this.overlay);

    this.scene = new THREE.Scene();
    this.qualityMeshes = [];
    this.scene.background = new THREE.Color(COLORS.backdrop);
    this.scene.fog = new THREE.Fog(COLORS.backdrop, 1.2, 3.2);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.14;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 2.35, 0.05, 8);
    this.buildLights();
    this.buildPiano();
    // The player has no arms to draw until the hands have loaded.
    this.player = new PlayerFigure();
    this.player.setLight(this.quality === "light");
    this.player.group.visible = false;
    this.scene.add(this.player.group);
    this.buildComposer();
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(element);
    if (!this.options.snapshot) this.bindPointer();

    this.ready = loadHandAsset().then((asset) => {
      const materials = { full: createSkinMaterial(asset.rig), light: createLightSkinMaterial() };
      for (const side of SIDES) {
        const actor = new HandActor(side, asset, materials);
        actor.setLightMaterial(this.quality === "light");
        this.hands[side] = actor;
        this.scene.add(actor.root);
      }
      this.player.group.visible = true;
      for (const side of SIDES) this.place(side, this.requests[side], { immediate: true });
      this.frameCamera(true);
      this.invalidate();
      return this;
    });
  }

  buildLights() {
    this.rigLights = new THREE.Group();
    this.scene.add(this.rigLights);
    this.scene.add(new THREE.HemisphereLight(0xffe9d2, 0x120c08, 0.05));

    const key = new THREE.SpotLight(0xffd9b0, 3.3, 4, Math.PI / 6, 1, 1.6);
    key.position.set(-0.6, 0.5, 0.05);
    key.castShadow = true;
    key.shadow.mapSize.set(QUALITY[this.quality].shadowMap, QUALITY[this.quality].shadowMap);
    key.shadow.camera.near = 0.3;
    key.shadow.camera.far = 2;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.0005;
    key.shadow.radius = 6;
    key.target.position.set(0, 0, -0.04);
    this.rigLights.add(key, key.target);
    this.keyLight = key;

    const rim = new THREE.SpotLight(0x9fbcff, 4.5, 3, Math.PI / 5, 0.9, 1.6);
    rim.position.set(0.5, 0.35, -0.6);
    rim.target.position.set(0, 0.02, 0);
    this.rigLights.add(rim, rim.target);
    this.rimLight = rim;

    const fill = new THREE.DirectionalLight(0xffc9a0, 0.06);
    fill.position.set(0.3, 0.5, 1);
    fill.target.position.set(0, 0, 0);
    this.rigLights.add(fill, fill.target);
  }

  buildPiano() {
    const piano = new THREE.Group();
    this.scene.add(piano);
    const whiteGeometry = new RoundedBoxGeometry(KEYBOARD.whiteWidth - KEYBOARD.keyGap, KEYBOARD.whiteDepth, KEYBOARD.whiteLength, 3, 0.0011);
    const blackHeight = KEYBOARD.blackRise + 0.006;
    const blackGeometry = new RoundedBoxGeometry(KEYBOARD.blackWidth, blackHeight, KEYBOARD.blackLength, 4, 0.0016);
    const position = blackGeometry.attributes.position;
    for (let index = 0; index < position.count; index += 1) {
      const t = (position.getY(index) + blackHeight / 2) / blackHeight;
      position.setX(index, position.getX(index) * (1 - t * (1 - KEYBOARD.blackTopWidth / KEYBOARD.blackWidth)));
      const z = position.getZ(index);
      // Slope the face that points at the player.
      if (z > 0) position.setZ(index, z - t * 0.0065 * (z / (KEYBOARD.blackLength / 2)));
    }
    blackGeometry.computeVertexNormals();

    const labels = this.buildLabelAtlas();
    this.labelMeshes = [];
    for (const key of KEYS.values()) {
      const pivot = new THREE.Group();
      pivot.position.set(key.x, 0, -KEYBOARD.pivot);
      const material = key.black
        ? new THREE.MeshPhysicalMaterial({ color: COLORS.ebony, roughness: 0.28, clearcoat: 0.7, clearcoatRoughness: 0.25, emissive: COLORS.gold, emissiveIntensity: 0 })
        : new THREE.MeshPhysicalMaterial({ color: COLORS.ivory, roughness: 0.34, clearcoat: 0.35, clearcoatRoughness: 0.4, emissive: COLORS.gold, emissiveIntensity: 0 });
      const lightMaterial = new THREE.MeshLambertMaterial({ color: key.black ? COLORS.ebony : COLORS.ivory, emissive: COLORS.gold, emissiveIntensity: 0 });
      const mesh = new THREE.Mesh(key.black ? blackGeometry : whiteGeometry, this.quality === "light" ? lightMaterial : material);
      this.qualityMeshes.push({ mesh, full: material, light: lightMaterial });
      if (key.black) mesh.position.set(0, KEYBOARD.blackRise - blackHeight / 2, KEYBOARD.pivot - KEYBOARD.whiteLength + KEYBOARD.blackLength / 2);
      else mesh.position.set(0, -KEYBOARD.whiteDepth / 2, KEYBOARD.pivot - KEYBOARD.whiteLength / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.midi = key.midi;
      pivot.add(mesh);
      if (!key.black) {
        const label = new THREE.Mesh(labels.geometryFor(key), labels.material);
        label.rotation.x = -Math.PI / 2;
        label.position.set(0, 0.00012, KEYBOARD.pivot - 0.0135);
        label.receiveShadow = true;
        label.visible = this.quality !== "light" && this.options.showNotes;
        pivot.add(label);
        this.labelMeshes.push(label);
      }
      piano.add(pivot);
      this.keys.set(key.midi, { key, pivot, mesh, material: this.quality === "light" ? lightMaterial : material, fullMaterial: material, lightMaterial, dip: 0, target: 0, delay: 0, glow: 0, glowTarget: 0, tint: 0, tintTarget: 0 });
    }
    this.keyMeshes = [...this.keys.values()].map((entry) => entry.mesh);

    const lacquer = new THREE.MeshPhysicalMaterial({ color: COLORS.lacquer, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.28 });
    const width = 52 * KEYBOARD.whiteWidth;
    const slip = new THREE.Mesh(new RoundedBoxGeometry(width + 0.2, 0.05, 0.06, 3, 0.004), lacquer);
    slip.position.set(0, -0.031, 0.0325);
    slip.receiveShadow = true;
    piano.add(slip);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, 0.02, 0.3), new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 0.9 }));
    bed.position.set(0, -0.034, -0.12);
    piano.add(bed);
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.075, 0.24, 3, 0.006), lacquer);
      cheek.position.set(side * (width / 2 + 0.0515), 0.0, -0.06);
      cheek.castShadow = true;
      cheek.receiveShadow = true;
      piano.add(cheek);
    }
    const felt = new THREE.Mesh(new THREE.BoxGeometry(width, 0.012, 0.006), new THREE.MeshStandardMaterial({ color: COLORS.felt, roughness: 1 }));
    felt.position.set(0, 0.0, -KEYBOARD.whiteLength - 0.0035);
    piano.add(felt);

    // The fallboard: black lacquer deep enough to mirror the keys and hands.
    const pixelRatio = this.renderer.getPixelRatio();
    const mirror = new Reflector(new THREE.PlaneGeometry(width + 0.2, 0.2), {
      clipBias: 0.002,
      textureWidth: Math.round(1400 * pixelRatio * 0.6),
      textureHeight: Math.round(360 * pixelRatio * 0.6),
      color: 0x0f0f0f,
    });
    // Lacquer reflects a fraction of what it sees; the stock overlay blend would
    // let bright keys through at full strength.
    mirror.material.fragmentShader = mirror.material.fragmentShader.replace(
      "gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );",
      "gl_FragColor = vec4( min( base.rgb, vec3( 1.4 ) ) * 0.2, 1.0 );",
    );
    mirror.position.set(0, 0.105, -KEYBOARD.whiteLength - 0.0068);
    mirror.rotation.x = -0.08;
    mirror.visible = this.quality !== "light";
    piano.add(mirror);
    this.fallboardMirror = mirror;
    const sheen = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 0.2, 0.2),
      new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.1, transparent: true, opacity: 0.35 }),
    );
    sheen.position.copy(mirror.position);
    sheen.position.z += 0.0004;
    sheen.rotation.copy(mirror.rotation);
    sheen.visible = this.quality !== "light";
    piano.add(sheen);
    this.fallboardSheen = sheen;
    const top = new THREE.Mesh(new RoundedBoxGeometry(width + 0.2, 0.02, 0.12, 3, 0.004), lacquer);
    top.position.set(0, 0.212, -KEYBOARD.whiteLength - 0.075);
    piano.add(top);
  }

  // One texture holding every white key's note name.
  buildLabelAtlas() {
    const whites = [...KEYS.values()].filter((key) => !key.black);
    const columns = 8;
    const rows = Math.ceil(whites.length / columns);
    const cell = 96;
    const canvas = document.createElement("canvas");
    canvas.width = columns * cell;
    canvas.height = rows * cell;
    const context = canvas.getContext("2d");
    context.textAlign = "center";
    context.textBaseline = "middle";
    const cells = new Map();
    whites.forEach((key, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const isC = key.note.startsWith("C");
      context.font = `${isC ? 700 : 600} ${isC ? 40 : 36}px "Avenir Next", "Gill Sans", "Helvetica Neue", sans-serif`;
      context.fillStyle = isC ? "rgba(96, 50, 30, 0.95)" : "rgba(88, 70, 58, 0.72)";
      context.fillText(key.note, column * cell + cell / 2, row * cell + cell / 2 + 2);
      cells.set(key.midi, { column, row });
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    return {
      material,
      geometryFor: (key) => {
        const geometry = new THREE.PlaneGeometry(0.0205, 0.0205);
        const { column, row } = cells.get(key.midi);
        const uv = geometry.attributes.uv;
        for (let index = 0; index < uv.count; index += 1) {
          uv.setXY(index, (column + uv.getX(index)) / columns, 1 - (row + 1 - uv.getY(index)) / rows);
        }
        return geometry;
      },
    };
  }

  buildComposer() {
    const level = QUALITY[this.quality];
    this.composer?.dispose();
    this.composer = null;
    this.lens = null;
    this.bloom = null;
    // With no image effects, rendering through half-float ping-pong targets
    // adds two full-screen copies for no visual benefit.
    if (!level.lens && !level.bloom) return;
    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: level.samples });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // A wide lens held close: the hands are sharp, the far keys and the sleeves fall soft.
    this.lens = new BokehPass(this.scene, this.camera, { focus: 0.6, aperture: this.options.aperture ?? 0.002, maxblur: 0.0045 });
    this.lens.enabled = level.lens;
    this.composer.addPass(this.lens);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.18, 0.6, 1.0);
    this.bloom.enabled = level.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.finish);
    if (this.width) this.composer.setSize(this.width, this.height);
  }

  // Changes how much work each frame does. A level the player picks is kept
  // for next time; one the stage falls back to on its own is not.
  setQuality(name, { chosen = true } = {}) {
    const level = QUALITY[name];
    if (!level) return;
    if (chosen) {
      this.chosenQuality = name;
      try {
        window.localStorage?.setItem(QUALITY_KEY, name);
      } catch {
        // Not remembered.
      }
    }
    if (name !== this.quality) {
      this.quality = name;
      this.slowFrames = 0;
      this.renderer.setPixelRatio(this.options.snapshot ? 1 : Math.min(window.devicePixelRatio || 1, level.pixelRatio));
      this.renderer.setSize(this.width, this.height, false);
      this.renderer.shadowMap.enabled = level.shadows;
      this.renderer.shadowMap.type = level.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
      this.renderer.shadowMap.needsUpdate = true;
      this.keyLight.shadow.mapSize.set(level.shadowMap, level.shadowMap);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
      if (this.fallboardMirror) this.fallboardMirror.visible = name !== "light";
      if (this.fallboardSheen) this.fallboardSheen.visible = name !== "light";
      for (const entry of this.qualityMeshes) entry.mesh.material = name === "light" ? entry.light : entry.full;
      for (const entry of this.keys.values()) entry.material = name === "light" ? entry.lightMaterial : entry.fullMaterial;
      for (const label of this.labelMeshes) label.visible = name !== "light" && this.options.showNotes;
      for (const actor of Object.values(this.hands)) actor.setLightMaterial(name === "light");
      this.player.setLight(name === "light");
      // Materials bake the shadow settings into their shaders.
      this.scene.traverse((object) => {
        if (object.material) object.material.needsUpdate = true;
      });
      this.buildComposer();
    }
    this.showQuality();
    this.invalidate();
  }

  // Too many slow frames in a row: take a step down, unless the player chose this level.
  noteFrame(delta, moving) {
    if (!moving || this.chosenQuality || this.options.snapshot) return;
    this.slowFrames = delta > SLOW_FRAME ? this.slowFrames + 1 : 0;
    if (this.slowFrames < SLOW_FRAMES) return;
    const next = QUALITY_ORDER[QUALITY_ORDER.indexOf(this.quality) + 1];
    if (next) {
      console.info(`MusicHands: frames are falling behind, so the stage is dropping to the ${QUALITY[next].label.toLowerCase()} detail level.`);
      this.setQuality(next, { chosen: false });
    }
    this.slowFrames = 0;
  }

  showQuality() {
    if (!this.qualitySelect) return;
    this.qualitySelect.value = this.quality;
    this.qualitySelect.title = this.chosenQuality ? "How much detail the picture has; less is easier on this computer" : `Detail level, chosen for this computer as it goes: ${QUALITY[this.quality].label.toLowerCase()}`;
  }

  resize() {
    const width = this.options.width ?? Math.max(1, this.element.clientWidth);
    const height = this.options.height ?? Math.max(1, this.element.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.frameCamera(true);
    this.invalidate();
  }

  setOptions(options) {
    const before = JSON.stringify([this.options.curl, this.options.lift, this.options.scale]);
    Object.assign(this.options, options);
    for (const label of this.labelMeshes) label.visible = this.quality !== "light" && this.options.showNotes;
    this.overlay.hidden = !this.options.showBadges;
    if (before !== JSON.stringify([this.options.curl, this.options.lift, this.options.scale])) {
      this.solved.clear();
      this.prepared.clear();
      for (const side of SIDES) {
        if (this.requests[side]) this.place(side, { ...this.requests[side], strike: false }, { settle: true });
        else if (this.hands[side]) this.place(side, null, { immediate: true });
      }
    }
    this.invalidate();
  }

  // How long, in ms, a strike takes at its longest at the current speed.
  get reach() {
    return (480 + KEY_LAG + KEY_FALL) / this.options.speed;
  }

  // specs: { left, right }, each { fingers: [{ finger, note }], activeMidis: [], strike: bool, strikeMidis: [] },
  // or null to rest that hand on the player's lap. Returns how many milliseconds from now the
  // struck keys will land, so sound can be timed to the fingers. With `landIn`
  // the strike is timed to land that many milliseconds from now: the hands
  // wait if that is more time than they need, and hurry if it is less.
  setHands(specs, { immediate = false, landIn = null } = {}) {
    const asked = performance.now();
    // Take the old move to the current clock before replacing it, even if no
    // animation frame was drawn between these two fast notes.
    for (const actor of Object.values(this.hands)) actor.step(asked);
    if (this.stillOnly) immediate = true;
    for (const side of SIDES) {
      const spec = specs[side];
      this.requests[side] = spec
        ? {
            fingers: spec.fingers.map((entry) => ({ ...entry })),
            activeMidis: [...(spec.activeMidis ?? [])].map(Number),
            strike: Boolean(spec.strike),
            // Which of the active notes are struck; the rest are held over. All of them, unless told.
            strikeMidis: spec.strikeMidis ? [...spec.strikeMidis].map(Number) : null,
          }
        : null;
    }
    this.refreshKeys(immediate);
    const plans = [];
    for (const side of SIDES) {
      const plan = this.hands[side] ? this.place(side, this.requests[side], { immediate }) : null;
      if (plan) plans.push(plan);
    }
    let landing = 0;
    this.pace = this.options.speed;
    if (plans.length) {
      // Hands that strike together land together, however far each had to travel.
      let travel = Math.max(...plans.map((plan) => plan.travel));
      let [lag, fall, press] = [KEY_LAG, KEY_FALL, PRESS].map((ms) => ms / this.options.speed);
      let wait = 0;
      if (landIn !== null) {
        landIn = Math.max(0, landIn - (performance.now() - asked));
        const natural = travel + lag + fall;
        if (landIn < natural) {
          const squeeze = Math.max(landIn, 24) / natural;
          [travel, lag, fall, press] = [travel, lag, fall, press].map((ms) => ms * squeeze);
          this.pace = this.options.speed / squeeze;
        } else {
          wait = landIn - natural;
        }
      }
      const down = performance.now() + wait + travel + lag;
      for (const plan of plans) {
        plan.approach.duration = travel;
        plan.press.duration = press;
        if (wait > 1) plan.actor.segments.unshift({ from: plan.approach.from, to: plan.approach.from, duration: wait, ease: easeInOut, arc: 0 });
        for (const midi of plan.keys) this.keys.get(midi).delay = down;
      }
      landing = wait + travel + lag + fall;
    }
    const start = performance.now();
    for (const actor of Object.values(this.hands)) {
      if (actor.segments.length) actor.segments[0].start ??= start;
    }
    this.frameCamera(immediate);
    this.invalidate();
    return landing;
  }

  // Keys that sound without a hand on them (a click, or a note outside the position).
  // `struck` are the ones that go down afresh, `delay` ms from now: a key
  // already down comes up first, the way it would under a finger.
  setSounding(midis, { struck = [], delay = 0 } = {}) {
    this.sounding = new Set([...midis].map(Number));
    this.refreshKeys(false);
    const down = performance.now() + Math.max(0, delay - KEY_FALL / this.pace);
    for (const midi of struck) {
      const entry = this.keys.get(Number(midi));
      if (entry && this.sounding.has(Number(midi))) entry.delay = down;
    }
    this.invalidate();
  }

  solve(side, request, states, pin = false) {
    const id = `${side}|${request.fingers.map((entry) => `${entry.finger}:${entry.note}:${states[entry.finger] ?? "rest"}`).join(",")}`;
    const cached = this.prepared.get(id) ?? this.solved.get(id);
    if (cached) {
      if (pin) this.prepared.set(id, cached);
      return cached;
    }
    const rig = this.hands[side].rig;
    const mirror = side === "left";
    const targets = request.fingers.map((entry) => {
      const key = keyFor(noteToMidi(entry.note));
      return { finger: entry.finger, key: mirror ? mirrorKey(key) : key, state: states[entry.finger] ?? "rest" };
    });
    const options = { scale: this.options.scale, curl: this.options.curl, lift: this.options.lift, mirror };
    const restId = `${side}|${request.fingers.map((entry) => `${entry.finger}:${entry.note}`).join(",")}|base`;
    let base = this.solved.get(restId);
    if (!base) {
      base = solvePose(rig, targets.map((target) => ({ ...target, state: "rest" })), options);
      this.solved.set(restId, base);
    }
    const moved = Object.values(states).some((state) => state !== "rest");
    const result = moved ? solvePose(rig, targets, { ...options, from: base }) : base;
    this.solved.set(id, result);
    if (pin) this.prepared.set(id, result);
    if (this.solved.size > 4000) this.solved.delete(this.solved.keys().next().value);
    return result;
  }

  // Solve every pose a score will need while the player is still reading the
  // page. Doing inverse kinematics on the note's deadline causes audible and
  // visible stalls in dense passages, even when rendering itself is cheap.
  // Ordinarily the work goes in idle moments so the page stays quick under
  // the pointer; when it is `urgent` (Play is pressed and everyone is waiting
  // on it) it runs in long stretches with only a breath between them.
  prepareHands(specs, { urgent = false } = {}) {
    const generation = (this.prepareGeneration ?? 0) + 1;
    this.prepareGeneration = generation;
    this.prepared.clear();
    const jobs = [];
    const seen = new Set();
    for (const hands of specs) {
      for (const side of SIDES) {
        const request = hands[side];
        if (!request || !this.hands[side]) continue;
        const active = new Set(request.activeMidis ?? []);
        const struck = request.strikeMidis ? new Set(request.strikeMidis) : active;
        const pressed = {};
        const lifted = {};
        for (const entry of request.fingers) {
          const midi = noteToMidi(entry.note);
          if (!active.has(midi)) continue;
          pressed[entry.finger] = "pressed";
          lifted[entry.finger] = struck.has(midi) ? "lifted" : "pressed";
        }
        for (const states of [pressed, lifted]) {
          const key = `${side}|${request.fingers.map((entry) => `${entry.finger}:${entry.note}`).join(",")}|${JSON.stringify(states)}`;
          if (!seen.has(key)) {
            seen.add(key);
            jobs.push(() => this.solve(side, request, states, true));
          }
        }
      }
    }
    const stretch = urgent ? 40 : 8; // ms of solving before yielding
    return new Promise((resolve) => {
      const run = (deadline) => {
        if (generation !== this.prepareGeneration) return resolve(false);
        // One job is always allowed so browsers with a stingy idle budget
        // still make progress; after that, yield before interaction suffers.
        let worked = false;
        const started = performance.now();
        while (jobs.length && (!worked || (performance.now() - started < stretch && (urgent || deadline?.timeRemaining?.() > 2)))) {
          jobs.shift()();
          worked = true;
        }
        if (!jobs.length) return resolve(true);
        if (!urgent && window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 100 });
        else window.setTimeout(() => run(null), 0);
      };
      run({ timeRemaining: () => 0 });
    });
  }

  // Queues the move to a request. When fingers are about to strike, returns
  // { approach, travel, keys }: the move that brings them over the keys, how
  // long it takes, and which keys they will press.
  place(side, request, { immediate = false, settle = false } = {}) {
    const actor = this.hands[side];
    if (!actor) return null;
    actor.root.visible = true;
    if (!request) {
      actor.targets = [];
      actor.key = "";
      actor.extent = null;
      const lap = this.lapState();
      if (immediate || !actor.state) {
        actor.segments = [];
        actor.resting = true;
        actor.apply(lap);
      } else if (!actor.resting) {
        actor.resting = true;
        actor.segments = [{ from: actor.state, to: lap, duration: LAP.duration / this.options.speed, ease: easeInOut, arc: LAP.arc }];
      }
      return null;
    }
    const midiOf = new Map(request.fingers.map((entry) => [entry.finger, noteToMidi(entry.note)]));
    const active = new Set(request.activeMidis);
    const pressedStates = {};
    const liftedStates = {};
    // Fingers that strike lift first; fingers holding a note over stay down.
    const struck = request.strikeMidis ? new Set(request.strikeMidis) : active;
    for (const [finger, midi] of midiOf) {
      if (!active.has(midi)) continue;
      pressedStates[finger] = "pressed";
      liftedStates[finger] = struck.has(midi) ? "lifted" : "pressed";
    }
    const pressed = this.solve(side, request, pressedStates);
    // Frame the whole hand where it will come to rest, not just the keys it plays.
    const resting = poseMatrices(actor.rig, pressed.pose, pressed.scale);
    const reachX = Object.values(resting.balls).map((ball) => (actor.mirror ? -ball[0] : ball[0]));
    actor.extent = [Math.min(...reachX), Math.max(...reachX)];
    actor.targets = request.fingers.map((entry) => ({ finger: entry.finger, midi: midiOf.get(entry.finger) }));
    const key = `${request.fingers.map((entry) => `${entry.finger}:${entry.note}`).join(",")}|${[...active].sort().join(",")}`;
    const samePlace = actor.key === key;
    actor.key = key;
    const fromLap = actor.resting;
    actor.resting = false;

    const strikes = request.strike && Object.values(liftedStates).includes("lifted");
    const struckKeys = actor.targets.filter((target) => liftedStates[target.finger] === "lifted").map((target) => target.midi);
    if (immediate) {
      actor.segments = [];
      actor.apply({ pose: pressed.pose.slice(), scale: pressed.scale });
      return null;
    }
    const lifted = strikes ? this.solve(side, request, liftedStates) : null;
    const speed = this.options.speed;
    const strikeFrom = (from, duration, arc) => {
      const approach = { from, to: lifted, duration, ease: easeInOut, arc };
      const press = { from: lifted, to: pressed, duration: PRESS / speed, ease: easeIn, arc: 0 };
      actor.segments = [approach, press];
      return { actor, approach, press, travel: duration, keys: struckKeys };
    };
    if (!actor.state) actor.apply(this.lapState());
    if (samePlace && !request.strike && !settle) return null;

    const from = { pose: actor.state.pose.slice(), scale: actor.state.scale };
    // A hand coming up from the lap lifts over the front of the keys on its way.
    if (fromLap) {
      if (strikes) return strikeFrom(from, LAP.duration / speed, LAP.arc);
      actor.segments = [{ from, to: pressed, duration: LAP.duration / speed, ease: easeInOut, arc: LAP.arc }];
      return null;
    }
    const travel = Math.hypot(pressed.pose[0] - from.pose[0], pressed.pose[2] - from.pose[2]);
    const arc = clamp(travel * 0.22, 0, 0.022);
    if (strikes) return strikeFrom(from, clamp(170 + travel * 1500, 170, 480) / speed, arc);
    actor.segments = [{ from, to: pressed, duration: clamp(120 + travel * 1500, 120, 480) / speed, ease: easeInOut, arc }];
    return null;
  }

  // Where a hand waits on the player's lap.
  lapState() {
    return { pose: lapPose(), scale: this.options.scale };
  }

  // Fits the player's arms to the hands wherever they have got to.
  seatPlayer() {
    const actors = SIDES.map((side) => this.hands[side]).filter((actor) => actor?.state);
    if (!actors.some((actor) => actor.moved)) return;
    const hands = {};
    for (const actor of actors) {
      actor.moved = false;
      hands[actor.side] = { matrix: actor.root.matrix.elements, scale: actor.state.scale, swing: elbowSwing(actor.state.pose) };
    }
    this.player.pose(hands);
  }

  refreshKeys(immediate) {
    const held = new Set();
    const pressed = new Set(this.sounding);
    for (const side of SIDES) {
      const request = this.requests[side];
      if (!request) continue;
      for (const entry of request.fingers) held.add(noteToMidi(entry.note));
      for (const midi of request.activeMidis) pressed.add(midi);
    }
    for (const [midi, entry] of this.keys) {
      entry.tintTarget = held.has(midi) ? 1 : 0;
      entry.target = pressed.has(midi) ? 1 : 0;
      entry.glowTarget = entry.target;
      if (!entry.target) entry.delay = 0;
      if (immediate) {
        entry.dip = entry.target;
        entry.glow = entry.glowTarget;
        entry.tint = entry.tintTarget;
        entry.delay = 0;
        this.paintKey(entry);
      }
    }
  }

  paintKey(entry) {
    entry.pivot.rotation.x = (KEYBOARD.dip * entry.dip) / KEYBOARD.pivot;
    const base = entry.key.black ? COLORS.ebony : COLORS.ivory;
    const held = entry.key.black ? COLORS.ebonyHeld : COLORS.ivoryHeld;
    entry.material.color.set(base).lerp(new THREE.Color(held), entry.tint).lerp(new THREE.Color(COLORS.gold), entry.glow * 0.85);
    entry.material.emissiveIntensity = entry.glow * (entry.key.black ? 0.75 : 0.42);
  }

  stepKeys(now, delta) {
    let moving = false;
    for (const entry of this.keys.values()) {
      const waiting = entry.target === 1 && entry.delay > now;
      const dipTarget = waiting ? 0 : entry.target;
      const glowTarget = waiting ? 0 : entry.glowTarget;
      const follow = (value, target, rate) => {
        if (Math.abs(target - value) < 0.002) return target;
        return value + (target - value) * (1 - Math.exp(-delta * rate));
      };
      const dip = follow(entry.dip, dipTarget, (dipTarget > entry.dip ? 0.045 : 0.02) * this.pace);
      const glow = follow(entry.glow, glowTarget, 0.02 * this.pace);
      const tint = follow(entry.tint, entry.tintTarget, 0.012);
      if (dip !== entry.dip || glow !== entry.glow || tint !== entry.tint || waiting) {
        entry.dip = dip;
        entry.glow = glow;
        entry.tint = tint;
        this.paintKey(entry);
        moving = true;
      }
    }
    return moving;
  }

  frameCamera(immediate) {
    let low = Infinity;
    let high = -Infinity;
    for (const side of SIDES) {
      const request = this.requests[side];
      if (!request) continue;
      const extent = this.hands[side]?.extent ?? request.fingers.map((entry) => keyFor(noteToMidi(entry.note)).x);
      low = Math.min(low, ...extent);
      high = Math.max(high, ...extent);
    }
    if (low === Infinity) {
      low = -0.1;
      high = 0.1;
    }
    const minWidth = this.options.minWidth ?? CAMERA.minWidth;
    this.focus = { x: (low + high) / 2, width: Math.max(minWidth, high - low + CAMERA.margin * 2) };
    if (immediate) {
      this.view = { ...this.focus };
      this.aimCamera();
    }
  }

  aimCamera() {
    // The patch of keyboard to keep in view: as wide as the hands need, and
    // deep enough for the keys and wrists as seen from the starting angle.
    const depth = (this.options.depth ?? CAMERA.depth) / Math.sin((this.home.elevation * Math.PI) / 180);
    const lens = { vertical: this.camera.fov, aspect: this.camera.aspect };
    const patch = { width: this.view.width, depth };
    // Back away to keep the hands in frame as the camera turns, but not so far
    // that they become specks on a wide stage.
    const shot = cleanView({ azimuth: this.orbit.azimuth + this.drift.azimuth, elevation: this.orbit.elevation, zoom: this.orbit.zoom * this.drift.zoom });
    const framed = Math.min(framingDistance(patch, shot, lens), framingDistance(patch, this.home, lens) * FARTHEST);
    const distance = Math.max(0.16, framed / shot.zoom);
    const target = new THREE.Vector3(this.view.x, CAMERA.target[0], this.options.targetZ ?? CAMERA.target[1]);
    this.camera.position.fromArray(orbitPosition(target.toArray(), distance, shot));
    this.camera.lookAt(target);
    // Focus on the knuckles, a little above the keys.
    if (this.lens) this.lens.uniforms.focus.value = this.camera.position.distanceTo(new THREE.Vector3(this.view.x, 0.045, 0.0));
    this.rigLights.position.x = this.view.x;
    this.rigLights.updateMatrixWorld(true);
  }

  stepCamera(delta) {
    const dx = this.focus.x - this.view.x;
    const dw = this.focus.width - this.view.width;
    const da = this.orbitGoal.azimuth - this.orbit.azimuth;
    const de = this.orbitGoal.elevation - this.orbit.elevation;
    const dz = this.orbitGoal.zoom - this.orbit.zoom;
    const framed = Math.abs(dx) < 0.0002 && Math.abs(dw) < 0.0002;
    const turned = Math.abs(da) < 0.02 && Math.abs(de) < 0.02 && Math.abs(dz) < 0.002;
    const drifting = this.rolling && this.autoCut && !this.stillOnly;
    if (framed && turned && !drifting) return false;
    const rate = 1 - Math.exp(-delta * 0.0045);
    this.view.x += dx * rate;
    this.view.width += dw * rate;
    // Turning follows the pointer closely; framing glides.
    const turn = turned ? 1 : 1 - Math.exp(-delta * 0.02);
    this.orbit.azimuth += da * turn;
    this.orbit.elevation += de * turn;
    this.orbit.zoom += dz * turn;
    if (drifting) {
      // Within a shot the camera creeps round and in, so no picture is ever still.
      this.drift.azimuth += this.drift.turn * DRIFT.turn * (delta / 1000);
      this.drift.zoom *= 1 + DRIFT.push * (delta / 1000);
    }
    this.aimCamera();
    return true;
  }

  // Move the camera to a view, or back to where it started. A view the
  // camera cut to on its own is not the one to come back to next visit.
  setView(view = this.home, { immediate = false, remember = true } = {}) {
    this.orbitGoal = { ...this.home, ...view };
    this.drift = { azimuth: 0, zoom: 1, turn: -this.drift.turn };
    if (immediate || this.stillOnly) {
      this.orbit = { ...this.orbitGoal };
      this.aimCamera();
    }
    this.showCameraState();
    if (remember && this.kept) this.options.onCamera({ view: cleanView(this.orbitGoal) });
    else if (remember && this.options.viewKey) {
      try {
        window.localStorage?.setItem(`musichands-view-${this.options.viewKey}`, JSON.stringify(this.orbitGoal));
      } catch {
        // The view is simply not remembered.
      }
    }
    this.invalidate();
  }

  // The camera as a page keeps it: where it looks, the saved views, and whether it cuts on its own.
  get cameraState() {
    return { view: cleanView(this.orbitGoal), shots: this.shots.views.map((view) => ({ ...view })), autoCut: this.autoCut };
  }

  // Takes the camera state a page keeps, without reporting it back. Only a
  // view that has changed since it was last given moves the camera: the page
  // keeps sending the same one, and it must not undo a cut the camera made on its own.
  applyCamera({ view, shots, autoCut } = {}, { immediate = false } = {}) {
    if (view && !sameView(view, this.givenView ?? this.orbitGoal)) this.setView(view, { immediate, remember: false });
    if (view) this.givenView = { ...view };
    const wanted = shots ?? STARTER_SHOTS;
    if (JSON.stringify(wanted) !== JSON.stringify(this.shots.views)) {
      this.shots = new ShotList(wanted);
      if (this.shotRail) this.showShots();
    }
    if (typeof autoCut === "boolean" && autoCut !== this.autoCut) {
      this.autoCut = autoCut;
      this.drift = { azimuth: 0, zoom: 1, turn: this.drift.turn };
      this.aimCamera();
    }
    this.showCameraState();
    this.invalidate();
  }

  // Where each finger number belongs, in stage pixels: on the key just past the fingertip.
  badgePoints() {
    const points = [];
    if (!this.options.showBadges) return points;
    for (const side of SIDES) {
      const actor = this.hands[side];
      if (!actor?.root.visible) continue;
      for (const target of actor.targets) {
        const ball = actor.balls[target.finger];
        if (!ball) continue;
        // Just past the furthest part of the finger, at that part's own height,
        // so the number clears the finger from wherever the camera sits.
        const point = actor.reach[target.finger].clone().add(new THREE.Vector3(0, 0, -0.016)).project(this.camera);
        points.push({ id: `${side}-${target.finger}`, finger: target.finger, x: ((point.x + 1) / 2) * this.width, y: ((1 - point.y) / 2) * this.height });
      }
    }
    return points;
  }

  updateBadges() {
    const wanted = this.badgePoints();
    const existing = new Map([...this.overlay.children].map((node) => [node.dataset.id, node]));
    for (const entry of wanted) {
      let node = existing.get(entry.id);
      if (!node) {
        node = document.createElement("span");
        node.className = "hand-stage__badge";
        node.dataset.id = entry.id;
        node.textContent = entry.finger;
        this.overlay.append(node);
      }
      existing.delete(entry.id);
      node.style.transform = `translate(-50%, -50%) translate(${entry.x.toFixed(1)}px, ${entry.y.toFixed(1)}px)`;
    }
    for (const node of existing.values()) node.remove();
  }

  invalidate() {
    this.needsRender = true;
    if (this.running || this.options.snapshot) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame((now) => this.tick(now));
  }

  tick(now) {
    const cap = QUALITY[this.quality].frameCap;
    const due = !cap || now - this.lastRendered >= 1000 / cap - 2;
    // Capping only the draw still did all pose solving and scene updates at the
    // display refresh rate. Light caps the whole animation workload instead.
    if (!due) {
      requestAnimationFrame((next) => this.tick(next));
      return;
    }
    const raw = now - this.lastTime;
    const delta = Math.max(0, Math.min(50, raw));
    this.lastTime = now;
    let moving = false;
    try {
      moving = this.stepKeys(now, delta);
      for (const side of SIDES) {
        const actor = this.hands[side];
        if (actor?.segments.length) this.needsRender = true;
        if (actor?.step(now)) moving = true;
      }
      if (this.stepCamera(delta)) moving = true;
      // A capped frame rate lets the motion run on while drawing fewer pictures of it.
      if ((moving || this.needsRender) && due) {
        this.render();
        this.lastRendered = now;
        this.needsRender = false;
      }
      this.noteFrame(raw, moving);
    } finally {
      // Never leave the loop marked as running if a frame fails.
      this.running = moving;
    }
    if (moving) requestAnimationFrame((next) => this.tick(next));
  }

  render() {
    this.seatPlayer();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.updateBadges();
  }

  // Draw the current request straight away, with nothing in motion.
  renderNow() {
    this.refreshKeys(true);
    for (const side of SIDES) if (this.hands[side]) this.place(side, this.requests[side], { immediate: true });
    this.frameCamera(true);
    this.render();
  }

  // Copy the current picture, finger numbers included, onto a 2D canvas.
  paintTo(canvas, { render = true } = {}) {
    if (render) this.render();
    const context = canvas.getContext("2d");
    context.drawImage(this.canvas, 0, 0, canvas.width, canvas.height);
    const scale = canvas.width / this.width;
    const radius = Math.max(7, 9.5 * scale * (this.options.badgeScale ?? 1));
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `italic 700 ${Math.round(radius * 1.25)}px Baskerville, "Times New Roman", serif`;
    for (const badge of this.badgePoints()) {
      context.beginPath();
      context.arc(badge.x * scale, badge.y * scale, radius, 0, Math.PI * 2);
      context.fillStyle = "#f5edde";
      context.fill();
      context.lineWidth = Math.max(1, radius * 0.14);
      context.strokeStyle = "#bd512f";
      context.stroke();
      context.fillStyle = "#82351f";
      context.fillText(String(badge.finger), badge.x * scale, badge.y * scale + radius * 0.06);
    }
  }

  // Dragging turns the camera. A press that stays put is a click, which
  // plays the key under it when the stage is interactive.
  bindPointer() {
    const raycaster = new THREE.Raycaster();
    const gestures = new Map();
    const midiAt = (event) => {
      if (!this.options.interactive) return null;
      const rect = this.canvas.getBoundingClientRect();
      const point = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(point, this.camera);
      const [hit] = raycaster.intersectObjects(this.keyMeshes, false);
      return hit ? hit.object.userData.midi : null;
    };
    const send = (type, midi) => this.element.dispatchEvent(new CustomEvent(type, { detail: { midi, source: "pointer" } }));
    const finish = (event) => {
      const gesture = gestures.get(event.pointerId);
      if (!gesture) return;
      gestures.delete(event.pointerId);
      if (gesture.midi !== null) send("noteoff", gesture.midi);
      if (gesture.turning) this.canvas.classList.remove("is-turning");
      if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    };

    this.canvas.title = "Drag to turn the view";
    this.canvas.addEventListener("pointerdown", (event) => {
      // Shift or the right button turns the view from anywhere, without playing a key.
      const turnOnly = event.shiftKey || event.button === 2;
      if (event.button !== 0 && !turnOnly) return;
      const midi = turnOnly ? null : midiAt(event);
      event.preventDefault();
      gestures.set(event.pointerId, { x: event.clientX, y: event.clientY, midi, turning: false, from: { ...this.orbitGoal } });
      this.canvas.setPointerCapture?.(event.pointerId);
      if (midi !== null) send("noteon", midi);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      const gesture = gestures.get(event.pointerId);
      if (!gesture) {
        this.canvas.style.cursor = midiAt(event) === null ? "grab" : "pointer";
        return;
      }
      const [dx, dy] = [event.clientX - gesture.x, event.clientY - gesture.y];
      if (!gesture.turning) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        gesture.turning = true;
        this.canvas.classList.add("is-turning");
        // The press turned out to be a drag, so let go of the key it landed on.
        if (gesture.midi !== null) send("noteoff", gesture.midi);
        gesture.midi = null;
      }
      this.setView(dragOrbit(gesture.from, dx, dy));
    });
    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("dblclick", (event) => {
      if (midiAt(event) === null) this.setView();
    });

    this.buildCameraBar();
  }

  // The controls along the bottom of the stage: closer and farther, the saved
  // views, and cutting between them.
  buildCameraBar() {
    const button = (className, label, title, onClick) => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = className;
      node.textContent = label;
      node.title = title;
      node.addEventListener("click", onClick);
      return node;
    };
    const group = (className, ...children) => {
      const node = document.createElement("div");
      node.className = className;
      node.append(...children);
      return node;
    };
    this.cameraBar = group("hand-stage__camera");
    this.cameraBar.setAttribute("role", "group");
    this.cameraBar.setAttribute("aria-label", "Camera");
    this.shotRail = group("camera-shots");
    this.saveButton = button("camera-button camera-save", "Save view", "Keep this camera position", () => this.saveShot());
    this.autoButton = button("camera-button camera-auto", "Auto cut", "Cut between your saved views as the music plays", () => this.setAutoCut(!this.autoCut));
    this.autoButton.hidden = !this.options.autoCut;
    this.resetButton = button("camera-button hand-stage__reset", "Reset view", "Put the camera back where it started", () => this.setView());
    this.qualitySelect = document.createElement("select");
    this.qualitySelect.className = "camera-button camera-quality";
    this.qualitySelect.setAttribute("aria-label", "Detail level");
    for (const [name, level] of Object.entries(QUALITY)) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = `${level.label} detail`;
      this.qualitySelect.append(option);
    }
    this.qualitySelect.addEventListener("change", () => this.setQuality(this.qualitySelect.value));
    this.showQuality();
    this.cameraBar.append(
      group(
        "camera-zoom",
        button("camera-button", "−", "Move the camera back", () => this.zoomBy(1 / ZOOM_STEP)),
        button("camera-button", "+", "Move the camera closer", () => this.zoomBy(ZOOM_STEP)),
      ),
      this.shotRail,
      this.saveButton,
      group("camera-right", this.qualitySelect, this.autoButton, this.resetButton),
    );
    this.element.append(this.cameraBar);
    this.showShots();
    this.showCameraState();
  }

  showCameraState() {
    if (!this.cameraBar) return;
    this.resetButton.hidden = sameView(this.orbitGoal, this.home);
    this.autoButton.setAttribute("aria-pressed", String(this.autoCut));
    this.autoButton.classList.toggle("is-on", this.autoCut);
    this.saveButton.disabled = this.shots.full;
    [...this.shotRail.children].forEach((chip, index) => {
      chip.classList.toggle("is-current", sameView(this.shots.views[index], this.orbitGoal));
    });
  }

  showShots() {
    this.shotRail.replaceChildren(
      ...this.shots.views.map((view, index) => {
        const chip = document.createElement("span");
        chip.className = "camera-shot";
        const go = document.createElement("button");
        go.type = "button";
        go.className = "camera-shot__go";
        go.textContent = index + 1;
        go.title = `Go to saved view ${index + 1}`;
        go.addEventListener("click", () => this.goToShot(index));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "camera-shot__remove";
        remove.textContent = "×";
        remove.title = `Remove saved view ${index + 1}`;
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => this.removeShot(index));
        chip.append(go, remove);
        return chip;
      }),
    );
    if (this.kept) return;
    try {
      window.localStorage?.setItem(SHOTS_KEY, JSON.stringify(this.shots.views));
    } catch {
      // The views last only for this visit.
    }
  }

  zoomBy(factor) {
    this.setView(zoomView(this.orbitGoal, factor));
  }

  saveShot() {
    const index = this.shots.add(cleanView(this.orbitGoal));
    if (index === -1) return;
    this.showShots();
    this.showCameraState();
    if (this.kept) this.options.onCamera({ shots: this.shots.views });
  }

  removeShot(index) {
    this.shots.remove(index);
    this.showShots();
    this.showCameraState();
    if (this.kept) this.options.onCamera({ shots: this.shots.views });
  }

  goToShot(index, { cut = false } = {}) {
    const view = this.shots.views[index];
    if (!view) return;
    this.shots.at = index;
    this.lastCut = performance.now();
    this.setView(view, { immediate: cut });
  }

  setAutoCut(on) {
    this.autoCut = Boolean(on);
    this.drift = { azimuth: 0, zoom: 1, turn: this.drift.turn };
    if (this.kept) this.options.onCamera({ autoCut: this.autoCut });
    else {
      try {
        window.localStorage?.setItem(AUTO_CUT_KEY, this.autoCut ? "on" : "off");
      } catch {
        // Not remembered.
      }
    }
    this.showCameraState();
    this.aimCamera();
    this.invalidate();
  }

  // Tell the stage whether music is playing, so the camera knows when to move on its own.
  setRolling(rolling) {
    if (this.rolling === Boolean(rolling)) return;
    this.rolling = Boolean(rolling);
    if (!this.rolling && (this.drift.azimuth !== 0 || this.drift.zoom !== 1)) {
      // Settle on the shot as it was saved.
      this.drift = { azimuth: 0, zoom: 1, turn: this.drift.turn };
      this.aimCamera();
    }
    this.invalidate();
  }

  // Called as the music reaches a new step. Cuts to the next saved view when
  // auto cut is on, a measure is starting, and the shot has had its time.
  beat({ measureStarted = false } = {}) {
    if (!this.autoCut) return false;
    const now = performance.now();
    if (!dueForCut({ now, lastCut: this.lastCut, shots: this.shots.length, measureStarted })) return false;
    const view = this.shots.next(this.orbitGoal);
    this.lastCut = now;
    this.setView(view, { immediate: true, remember: false });
    return true;
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.composer?.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.overlay.remove();
    this.cameraBar?.remove();
  }
}

// Draws small stills of single hand positions, one shared renderer for all of
// them, and only once a picture has scrolled into view.
export class ThumbnailRenderer {
  constructor({ width = 320, height = 160 } = {}) {
    this.width = width;
    this.height = height;
    this.stage = null;
    this.queue = [];
    this.jobs = new WeakMap();
    this.busy = false;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer.unobserve(entry.target);
          this.queue.push(entry.target);
        }
        this.drain();
      },
      { rootMargin: "200px 400px" },
    );
  }

  // Put a picture of `fingers` on `hand` inside `container`.
  attach(container, hand, fingers) {
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    canvas.className = "hand-thumbnail";
    container.replaceChildren(canvas);
    this.jobs.set(canvas, { hand, fingers });
    this.observer.observe(canvas);
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (!this.paused) this.drain();
  }

  async drain() {
    if (this.paused || this.busy || !this.queue.length) return;
    this.busy = true;
    if (!this.stage) {
      const holder = document.createElement("div");
      this.stage = new HandStage(holder, { snapshot: true, width: this.width, height: this.height, minWidth: 0.3, depth: 0.22, targetZ: 0.0, badgeScale: 1.25 });
      await this.stage.ready;
    }
    while (this.queue.length && !this.paused) {
      const canvas = this.queue.shift();
      const job = this.jobs.get(canvas);
      if (!job || !canvas.isConnected) continue;
      for (const side of SIDES) this.stage.requests[side] = null;
      this.stage.requests[job.hand] = { fingers: job.fingers, activeMidis: [], strike: false };
      this.stage.renderNow();
      this.stage.paintTo(canvas, { render: false });
      canvas.dataset.ready = "true";
      // Thumbnail work is decorative; never compete with live interaction.
      await new Promise((resolve) => (window.requestIdleCallback ? window.requestIdleCallback(resolve, { timeout: 500 }) : requestAnimationFrame(resolve)));
    }
    // The copied canvases are ordinary bitmaps. Keeping this second, full-look
    // WebGL context alive retained all of its HDR targets and textures forever.
    this.stage.dispose();
    this.stage = null;
    this.busy = false;
  }
}

export function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}
