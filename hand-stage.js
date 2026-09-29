// The 3D stage: a piano keyboard and up to two hands, lit and filmed.
//
// Hands are a rigged mesh posed by hand-rig.js, so bones keep their lengths
// and every move between positions is a real joint rotation.
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
import { FINGER_JOINTS, readSkeleton } from "./glb-skeleton.js";
import { noteToMidi } from "./hand-model.js";
import { blendPose, createRig, poseMatrices, solvePose } from "./hand-rig.js";
import { KEYBOARD, KEYS, keyFor } from "./piano-geometry.js";
import { mat4 } from "./rig-math.js";

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
  sleeve: 0x0d0d10,
  cuff: 0xf2efe8,
};
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

// A jacket sleeve with a shirt cuff, from the wrist back toward the elbow.
function createSleeve() {
  const group = new THREE.Group();
  const ring = (radiusX, radiusY, z, centerY = -0.001) => ({ radiusX, radiusY, z, centerY });
  const loft = (rings, material, segments = 40) => {
    const positions = [];
    const indices = [];
    rings.forEach((entry, row) => {
      for (let step = 0; step <= segments; step += 1) {
        const angle = (step / segments) * Math.PI * 2;
        // A soft rectangle rather than an ellipse, the way cloth sits on a wrist.
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const squared = (value) => Math.sign(value) * Math.abs(value) ** 0.8;
        positions.push(0.001 + squared(c) * entry.radiusX, entry.centerY + squared(s) * entry.radiusY, entry.z);
        if (row < rings.length - 1 && step < segments) {
          const a = row * (segments + 1) + step;
          const b = a + segments + 1;
          indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const cuffMaterial = new THREE.MeshPhysicalMaterial({ color: COLORS.cuff, roughness: 0.85, sheen: 0.4, sheenRoughness: 0.8, side: THREE.DoubleSide });
  const sleeveMaterial = new THREE.MeshPhysicalMaterial({ color: COLORS.sleeve, roughness: 0.9, sheen: 1, sheenColor: new THREE.Color(0x3a3a48), sheenRoughness: 0.5, side: THREE.DoubleSide });
  group.add(
    loft(
      [ring(0.029, 0.0215, 0.006), ring(0.0335, 0.026, 0.0045), ring(0.0345, 0.027, 0.012), ring(0.035, 0.0275, 0.034)],
      cuffMaterial,
    ),
  );
  group.add(
    loft(
      [
        ring(0.03, 0.023, 0.021),
        ring(0.0385, 0.031, 0.0195),
        ring(0.04, 0.0325, 0.03),
        ring(0.043, 0.036, 0.1, -0.003),
        ring(0.05, 0.043, 0.22, -0.006),
        ring(0.058, 0.05, 0.42, -0.01),
      ],
      sleeveMaterial,
    ),
  );
  return group;
}

class HandActor {
  constructor(side, asset, material) {
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
    scene.traverse((object) => {
      if (object.isBone) {
        object.matrixAutoUpdate = false;
        this.bones.set(object.name, object);
      }
      if (object.isSkinnedMesh) {
        object.material = material;
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = false;
      }
    });
    this.sleeve = createSleeve();
    this.root.add(this.sleeve);

    this.segments = [];
    this.state = null; // { pose, scale }
    this.targets = []; // fingers currently assigned, for badges
    this.balls = {};
    this.key = "";
  }

  apply(state) {
    this.state = state;
    const { hand, joints, balls, reach } = poseMatrices(this.rig, state.pose, state.scale);
    this.reach = reach;
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
    while (this.segments.length) {
      const segment = this.segments[0];
      segment.start ??= now;
      const t = clamp((now - segment.start) / segment.duration, 0, 1);
      const eased = segment.ease(t);
      const blended = blendPose(segment.from, segment.to, eased);
      blended.pose[1] += Math.sin(Math.PI * t) * segment.arc;
      this.apply(blended);
      if (t < 1) return true;
      this.apply({ pose: segment.to.pose.slice(), scale: segment.to.scale });
      segment.done?.();
      this.segments.shift();
    }
    return false;
  }
}

export class HandStage {
  constructor(element, options = {}) {
    this.element = element;
    this.options = { interactive: false, showNotes: true, showBadges: true, curl: 0, lift: 0, scale: 1, snapshot: false, ...options };
    this.hands = {};
    this.requests = { left: null, right: null };
    this.solved = new Map();
    this.keys = new Map();
    this.held = new Set();
    this.sounding = new Set();
    this.focus = { x: 0, width: CAMERA.minWidth };
    this.view = { x: 0, width: CAMERA.minWidth };
    this.running = false;
    this.needsRender = true;
    this.lastTime = 0;
    this.stillOnly = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    element.classList.add("hand-stage");
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: Boolean(options.snapshot) });
    this.renderer.setPixelRatio(options.snapshot ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "hand-stage__canvas";
    element.append(this.canvas);
    this.overlay = document.createElement("div");
    this.overlay.className = "hand-stage__overlay";
    element.append(this.overlay);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.backdrop);
    this.scene.fog = new THREE.Fog(COLORS.backdrop, 1.2, 3.2);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.14;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 2.35, 0.05, 8);
    this.buildLights();
    this.buildPiano();
    this.buildComposer();
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(element);
    if (this.options.interactive) this.bindPointer();

    this.ready = loadHandAsset().then((asset) => {
      const material = createSkinMaterial(asset.rig);
      for (const side of SIDES) {
        const actor = new HandActor(side, asset, material);
        this.hands[side] = actor;
        this.scene.add(actor.root);
      }
      for (const side of SIDES) if (this.requests[side]) this.place(side, this.requests[side], { immediate: true });
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
    key.shadow.mapSize.set(2048, 2048);
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
      const mesh = new THREE.Mesh(key.black ? blackGeometry : whiteGeometry, material);
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
        pivot.add(label);
        this.labelMeshes.push(label);
      }
      piano.add(pivot);
      this.keys.set(key.midi, { key, pivot, mesh, material, dip: 0, target: 0, delay: 0, glow: 0, glowTarget: 0, tint: 0, tintTarget: 0 });
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
    piano.add(mirror);
    const sheen = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 0.2, 0.2),
      new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.1, transparent: true, opacity: 0.35 }),
    );
    sheen.position.copy(mirror.position);
    sheen.position.z += 0.0004;
    sheen.rotation.copy(mirror.rotation);
    piano.add(sheen);
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
    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // A wide lens held close: the hands are sharp, the far keys and the sleeves fall soft.
    this.lens = new BokehPass(this.scene, this.camera, { focus: 0.6, aperture: this.options.aperture ?? 0.002, maxblur: 0.0045 });
    this.composer.addPass(this.lens);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.18, 0.6, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.finish);
  }

  resize() {
    const width = this.options.width ?? Math.max(1, this.element.clientWidth);
    const height = this.options.height ?? Math.max(1, this.element.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.frameCamera(true);
    this.invalidate();
  }

  setOptions(options) {
    const before = JSON.stringify([this.options.curl, this.options.lift, this.options.scale]);
    Object.assign(this.options, options);
    for (const label of this.labelMeshes) label.visible = this.options.showNotes;
    this.overlay.hidden = !this.options.showBadges;
    if (before !== JSON.stringify([this.options.curl, this.options.lift, this.options.scale])) {
      this.solved.clear();
      for (const side of SIDES) if (this.requests[side]) this.place(side, this.requests[side], { settle: true });
    }
    this.invalidate();
  }

  // spec: { fingers: [{ finger, note }], activeMidis: [], strike: bool } or null to withdraw the hand.
  setHand(side, spec, { immediate = false } = {}) {
    if (this.stillOnly) immediate = true;
    this.requests[side] = spec ? { fingers: spec.fingers.map((entry) => ({ ...entry })), activeMidis: [...(spec.activeMidis ?? [])].map(Number), strike: Boolean(spec.strike) } : null;
    this.refreshKeys(immediate);
    if (this.hands[side]) this.place(side, this.requests[side], { immediate });
    this.frameCamera(immediate);
    this.invalidate();
  }

  // Keys that sound without a hand on them (a click, or a note outside the position).
  setSounding(midis) {
    this.sounding = new Set([...midis].map(Number));
    this.refreshKeys(false);
    this.invalidate();
  }

  solve(side, request, states) {
    const id = `${side}|${request.fingers.map((entry) => `${entry.finger}:${entry.note}:${states[entry.finger] ?? "rest"}`).join(",")}`;
    if (this.solved.has(id)) return this.solved.get(id);
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
    if (this.solved.size > 600) this.solved.delete(this.solved.keys().next().value);
    return result;
  }

  place(side, request, { immediate = false, settle = false } = {}) {
    const actor = this.hands[side];
    if (!actor) return;
    if (!request) {
      actor.targets = [];
      actor.key = "";
      actor.extent = null;
      if (immediate || !actor.root.visible || !actor.state) {
        actor.segments = [];
        actor.root.visible = false;
        return;
      }
      const away = { pose: actor.state.pose.slice(), scale: actor.state.scale };
      away.pose[1] += 0.05;
      away.pose[2] += 0.22;
      actor.segments = [{ from: actor.state, to: away, duration: 420, ease: easeInOut, arc: 0, done: () => { actor.root.visible = false; actor.state = null; } }];
      return;
    }
    const midiOf = new Map(request.fingers.map((entry) => [entry.finger, noteToMidi(entry.note)]));
    const active = new Set(request.activeMidis);
    const pressedStates = {};
    const liftedStates = {};
    for (const [finger, midi] of midiOf) {
      if (!active.has(midi)) continue;
      pressedStates[finger] = "pressed";
      liftedStates[finger] = "lifted";
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
    actor.root.visible = true;

    if (immediate || !actor.state) {
      actor.segments = [];
      if (!immediate && !actor.state) {
        const entering = { pose: pressed.pose.slice(), scale: pressed.scale };
        entering.pose[1] += 0.05;
        entering.pose[2] += 0.22;
        actor.apply(entering);
        actor.segments = [{ from: entering, to: pressed, duration: 520, ease: easeInOut, arc: 0 }];
      } else {
        actor.apply({ pose: pressed.pose.slice(), scale: pressed.scale });
      }
      return;
    }
    if (samePlace && !request.strike && !settle) return;

    const from = { pose: actor.state.pose.slice(), scale: actor.state.scale };
    const travel = Math.hypot(pressed.pose[0] - from.pose[0], pressed.pose[2] - from.pose[2]);
    const strikes = request.strike && Object.keys(liftedStates).length > 0;
    if (strikes) {
      const lifted = this.solve(side, request, liftedStates);
      const duration = clamp(170 + travel * 1500, 170, 480);
      for (const target of actor.targets) {
        if (liftedStates[target.finger]) this.keys.get(target.midi).delay = performance.now() + duration + 30;
      }
      actor.segments = [
        { from, to: lifted, duration, ease: easeInOut, arc: clamp(travel * 0.22, 0, 0.022) },
        { from: lifted, to: pressed, duration: 95, ease: easeIn, arc: 0 },
      ];
    } else {
      actor.segments = [{ from, to: pressed, duration: clamp(120 + travel * 1500, 120, 480), ease: easeInOut, arc: clamp(travel * 0.22, 0, 0.022) }];
    }
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
      const dip = follow(entry.dip, dipTarget, dipTarget > entry.dip ? 0.045 : 0.02);
      const glow = follow(entry.glow, glowTarget, 0.02);
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
    const vertical = (this.camera.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    // Wide stages frame by width; tall ones must still hold the hand and keys.
    const byWidth = this.view.width / (2 * Math.tan(horizontal / 2));
    const byHeight = (this.options.depth ?? CAMERA.depth) / (2 * Math.tan(vertical / 2));
    const distance = Math.max(byWidth, byHeight);
    const elevation = ((this.options.elevation ?? CAMERA.elevation) * Math.PI) / 180;
    const target = new THREE.Vector3(this.view.x, CAMERA.target[0], this.options.targetZ ?? CAMERA.target[1]);
    this.camera.position.set(this.view.x, target.y + Math.sin(elevation) * distance, target.z + Math.cos(elevation) * distance);
    this.camera.lookAt(target);
    // Focus on the knuckles, a little above the keys.
    if (this.lens) this.lens.uniforms.focus.value = this.camera.position.distanceTo(new THREE.Vector3(this.view.x, 0.045, 0.0));
    this.rigLights.position.x = this.view.x;
    this.rigLights.updateMatrixWorld(true);
  }

  stepCamera(delta) {
    const dx = this.focus.x - this.view.x;
    const dw = this.focus.width - this.view.width;
    if (Math.abs(dx) < 0.0002 && Math.abs(dw) < 0.0002) return false;
    const rate = 1 - Math.exp(-delta * 0.0045);
    this.view.x += dx * rate;
    this.view.width += dw * rate;
    this.aimCamera();
    return true;
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
        const point = new THREE.Vector3(ball.x, ball.y + 0.004, actor.reach[target.finger] - 0.017).project(this.camera);
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
    const delta = Math.max(0, Math.min(50, now - this.lastTime));
    this.lastTime = now;
    let moving = false;
    try {
      moving = this.stepKeys(now, delta);
      for (const side of SIDES) if (this.hands[side]?.step(now)) moving = true;
      if (this.stepCamera(delta)) moving = true;
      if (moving || this.needsRender) this.render();
      this.needsRender = false;
    } finally {
      // Never leave the loop marked as running if a frame fails.
      this.running = moving;
    }
    if (moving) requestAnimationFrame((next) => this.tick(next));
  }

  render() {
    this.composer.render();
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
  paintTo(canvas) {
    this.render();
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

  bindPointer() {
    const raycaster = new THREE.Raycaster();
    const pointers = new Map();
    const midiAt = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const point = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(point, this.camera);
      const [hit] = raycaster.intersectObjects(this.keyMeshes, false);
      return hit ? hit.object.userData.midi : null;
    };
    const release = (event) => {
      const midi = pointers.get(event.pointerId);
      if (midi === undefined) return;
      pointers.delete(event.pointerId);
      this.element.dispatchEvent(new CustomEvent("noteoff", { detail: { midi, source: "pointer" } }));
    };
    this.canvas.addEventListener("pointerdown", (event) => {
      const midi = midiAt(event);
      if (midi === null) return;
      event.preventDefault();
      pointers.set(event.pointerId, midi);
      this.element.dispatchEvent(new CustomEvent("noteon", { detail: { midi, source: "pointer" } }));
    });
    this.canvas.addEventListener("pointermove", (event) => {
      this.canvas.style.cursor = midiAt(event) === null ? "" : "pointer";
    });
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointerleave", release);
    this.canvas.addEventListener("pointercancel", release);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
    this.overlay.remove();
  }
}

// Draws small stills of single hand positions, one shared renderer for all of
// them, and only once a picture has scrolled into view.
export class ThumbnailRenderer {
  constructor({ width = 480, height = 240 } = {}) {
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

  async drain() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    if (!this.stage) {
      const holder = document.createElement("div");
      this.stage = new HandStage(holder, { snapshot: true, width: this.width, height: this.height, minWidth: 0.3, depth: 0.22, targetZ: 0.0, badgeScale: 1.25 });
      await this.stage.ready;
    }
    while (this.queue.length) {
      const canvas = this.queue.shift();
      const job = this.jobs.get(canvas);
      if (!job || !canvas.isConnected) continue;
      for (const side of SIDES) this.stage.requests[side] = null;
      this.stage.requests[job.hand] = { fingers: job.fingers, activeMidis: [], strike: false };
      this.stage.renderNow();
      this.stage.paintTo(canvas);
      canvas.dataset.ready = "true";
      // Leave the page room to breathe between pictures.
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
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
