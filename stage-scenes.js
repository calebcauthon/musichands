// The places the piano can stand, from looks.js: what is built around it and
// how it is lit. Each set is a function that returns { scenery, lights,
// keyLight }: the things to put in the scene, the lights (in a group the
// stage slides along with the camera), and the one light that casts shadows.
// To add a place, add a set here and name it in looks.js.
//
// Nothing is loaded from files: the textures are painted on canvases as the
// place is built, and the crowds and woods are drawn in one go each with
// instancing, so a place costs a few draw calls however much is in it.
import * as THREE from "three";
import { BODY } from "./player-body.js";

// A small deterministic random, so a place looks the same every visit.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

// Smooth value noise on a grid, summed over octaves, in 0…1.
function noiseField(seed, octaves = 4) {
  const random = seeded(seed);
  const size = 64;
  const grid = Float32Array.from({ length: size * size }, () => random());
  const at = (x, y) => grid[((y % size) + size) % size * size + (((x % size) + size) % size)];
  const value = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = smooth(x - x0), ty = smooth(y - y0);
    return lerp(lerp(at(x0, y0), at(x0 + 1, y0), tx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
  };
  return (x, y) => {
    let sum = 0, weight = 0.5, total = 0;
    for (let octave = 0; octave < octaves; octave += 1) {
      sum += value(x, y) * weight;
      total += weight;
      x *= 2.03;
      y *= 1.97;
      weight *= 0.5;
    }
    return sum / total;
  };
}

// A texture painted on a canvas by `paint(context, size)`.
function painted(size, paint, { repeat = 1, color = true } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paint(canvas.getContext("2d"), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// A texture of noise between two colours, with `scale` cells across it.
function noiseTexture(size, seed, [low, high], { scale = 6, octaves = 4, repeat = 1, speckle = 0 } = {}) {
  const field = noiseField(seed, octaves);
  const random = seeded(seed + 1);
  return painted(
    size,
    (context) => {
      const image = context.createImageData(size, size);
      const a = new THREE.Color(low), b = new THREE.Color(high);
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const t = Math.min(1, Math.max(0, field((x / size) * scale, (y / size) * scale) * 1.4 - 0.2 + (random() - 0.5) * speckle));
          const index = (y * size + x) * 4;
          image.data[index] = lerp(a.r, b.r, t) * 255;
          image.data[index + 1] = lerp(a.g, b.g, t) * 255;
          image.data[index + 2] = lerp(a.b, b.b, t) * 255;
          image.data[index + 3] = 255;
        }
      }
      context.putImageData(image, 0, 0);
    },
    { repeat },
  );
}

function spot(color, intensity, position, target, { angle = Math.PI / 6, penumbra = 1, distance = 4, decay = 1.6 } = {}) {
  const light = new THREE.SpotLight(color, intensity, distance, angle, penumbra, decay);
  light.position.set(...position);
  light.target.position.set(...target);
  return light;
}

// Sets a light up to cast the stage's shadows; the stage sizes the map itself.
function shadows(light, { near = 0.3, far = 2, bias = -0.0002, normalBias = 0.0005 } = {}) {
  light.castShadow = true;
  light.shadow.camera.near = near;
  light.shadow.camera.far = far;
  light.shadow.bias = bias;
  light.shadow.normalBias = normalBias;
  light.shadow.radius = 6;
  return light;
}

// Many copies of one shape, placed by `place(index, object)`, coloured by `tint(index)`.
function crowd(geometry, material, count, place, tint = null) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const object = new THREE.Object3D();
  for (let index = 0; index < count; index += 1) {
    object.position.set(0, 0, 0);
    object.rotation.set(0, 0, 0);
    object.scale.set(1, 1, 1);
    place(index, object);
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
    if (tint) mesh.setColorAt(index, tint(index));
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// A sky: a dome shaded from a haze at the horizon up to blue, with the sun's glow in it.
function skyDome(sunDirection) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Color(0xc4d9ea) },
      uZenith: { value: new THREE.Color(0x3d7ccb) },
      uSun: { value: sunDirection.clone().normalize() },
    },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform vec3 uSun;
      varying vec3 vDirection;
      void main() {
        float up = clamp(vDirection.y, 0.0, 1.0);
        vec3 sky = mix(uHorizon, uZenith, pow(up, 0.45));
        float toSun = max(dot(normalize(vDirection), uSun), 0.0);
        sky += vec3(1.0, 0.95, 0.85) * (pow(toSun, 220.0) * 1.6 + pow(toSun, 8.0) * 0.18);
        gl_FragColor = vec4(sky, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), material);
  dome.renderOrder = -1;
  return dome;
}

// The stage as it always was: darkness, one warm key light from the player's
// left, a cool rim from beyond the fallboard, and the faintest fill.
function stage() {
  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(0xffe9d2, 0x120c08, 0.05));
  const key = shadows(spot(0xffd9b0, 3.3, [-0.6, 0.5, 0.05], [0, 0, -0.04]));
  lights.add(key, key.target);
  const rim = spot(0x9fbcff, 4.5, [0.5, 0.35, -0.6], [0, 0.02, 0], { angle: Math.PI / 5, penumbra: 0.9, distance: 3 });
  lights.add(rim, rim.target);
  const fill = new THREE.DirectionalLight(0xffc9a0, 0.06);
  fill.position.set(0.3, 0.5, 1);
  lights.add(fill, fill.target);
  // A floor to stand the bench and the piano on, dark enough to lose in the fog.
  const scenery = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 32), new THREE.MeshStandardMaterial({ color: 0x0a0807, roughness: 0.6 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = BODY.floor;
  floor.receiveShadow = true;
  scenery.add(floor);
  return { scenery, lights, keyLight: key };
}

// A lawn on a bright afternoon: grass, a path, trees with real crowns of
// leaves, a bench and a lamp, woods on the horizon, and clouds.
function park() {
  const scenery = new THREE.Group();
  const random = seeded(7);
  const sunDirection = new THREE.Vector3(-1.6, 2.4, 1.1);
  scenery.add(skyDome(sunDirection));

  const grass = new THREE.Mesh(
    new THREE.CircleGeometry(120, 64),
    new THREE.MeshStandardMaterial({
      map: noiseTexture(512, 3, [0x3b6a26, 0x7aa548], { scale: 9, octaves: 5, repeat: 48, speckle: 0.35 }),
      roughness: 1,
    }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = BODY.floor;
  grass.receiveShadow = true;
  scenery.add(grass);
  // Gravel where the piano stands, worn into the lawn.
  const path = new THREE.Mesh(
    new THREE.CircleGeometry(3.4, 48),
    new THREE.MeshStandardMaterial({ map: noiseTexture(256, 5, [0x8b7d66, 0xbfb29b], { scale: 8, octaves: 4, repeat: 4, speckle: 0.5 }), roughness: 1 }),
  );
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, BODY.floor + 0.004, -0.4);
  path.receiveShadow = true;
  scenery.add(path);

  // Trees: a tapered trunk with a few branches, and a crown of leaf clumps,
  // each a card with leaves painted on it, hundreds of them in one draw.
  const trees = [];
  for (let index = 0; index < 26; index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = 5.5 + random() * 16;
    trees.push({ x: Math.sin(angle) * distance, z: Math.cos(angle) * distance, height: 3 + random() * 2.2, spread: 1.8 + random() * 1.4 });
  }
  const bark = new THREE.MeshStandardMaterial({ map: noiseTexture(256, 11, [0x3e2a1c, 0x7a5a40], { scale: 3, octaves: 5, repeat: 1, speckle: 0.2 }), roughness: 0.95 });
  bark.map.repeat.set(2, 6);
  scenery.add(
    crowd(new THREE.CylinderGeometry(0.11, 0.24, 1, 12), bark, trees.length, (index, object) => {
      const tree = trees[index];
      object.position.set(tree.x, BODY.floor + tree.height / 2, tree.z);
      object.scale.set(1, tree.height, 1);
      object.rotation.y = random() * Math.PI;
    }),
  );
  const branches = [];
  for (const tree of trees) {
    for (let count = 0; count < 4; count += 1) {
      const turn = random() * Math.PI * 2;
      branches.push({ tree, turn, tilt: 0.7 + random() * 0.5, from: tree.height * (0.55 + random() * 0.3), length: 1.2 + random() * 1.2 });
    }
  }
  scenery.add(
    crowd(new THREE.CylinderGeometry(0.03, 0.08, 1, 8), bark, branches.length, (index, object) => {
      const { tree, turn, tilt, from, length } = branches[index];
      object.position.set(tree.x + Math.sin(turn) * Math.sin(tilt) * length * 0.5, BODY.floor + from + Math.cos(tilt) * length * 0.5, tree.z + Math.cos(turn) * Math.sin(tilt) * length * 0.5);
      object.rotation.set(Math.cos(turn) * tilt, 0, -Math.sin(turn) * tilt);
      object.scale.set(1, length, 1);
    }),
  );
  const leafCard = painted(256, (context, size) => {
    context.clearRect(0, 0, size, size);
    for (let leaf = 0; leaf < 90; leaf += 1) {
      const x = size * (0.15 + random() * 0.7), y = size * (0.15 + random() * 0.7);
      // Leaves thin out toward the edge of the clump.
      if (Math.hypot(x - size / 2, y - size / 2) > size * 0.42 * (0.8 + random() * 0.3)) continue;
      const shade = 0.55 + random() * 0.55;
      context.fillStyle = `rgb(${Math.round(70 * shade)}, ${Math.round(125 * shade)}, ${Math.round(45 * shade)})`;
      context.save();
      context.translate(x, y);
      context.rotate(random() * Math.PI);
      context.beginPath();
      context.ellipse(0, 0, size * (0.035 + random() * 0.03), size * (0.014 + random() * 0.012), 0, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  });
  const leaves = new THREE.MeshStandardMaterial({ map: leafCard, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 });
  const clumps = [];
  for (const tree of trees) {
    for (let count = 0; count < 30; count += 1) {
      const u = random() * Math.PI * 2, v = Math.acos(2 * random() - 1), r = Math.cbrt(random());
      clumps.push({
        tree,
        offset: [Math.sin(v) * Math.cos(u) * r * tree.spread, Math.cos(v) * r * tree.spread * 0.75 + tree.height * 0.62 + tree.spread * 0.45, Math.sin(v) * Math.sin(u) * r * tree.spread],
        turn: [random() * Math.PI, random() * Math.PI, random() * Math.PI],
        size: 1.3 + random() * 1.3,
        shade: 0.75 + random() * 0.45,
      });
    }
  }
  scenery.add(
    crowd(
      new THREE.PlaneGeometry(1, 1),
      leaves,
      clumps.length,
      (index, object) => {
        const { tree, offset, turn, size } = clumps[index];
        object.position.set(tree.x + offset[0], BODY.floor + offset[1], tree.z + offset[2]);
        object.rotation.set(...turn);
        object.scale.set(size, size, 1);
      },
      (index) => new THREE.Color().setScalar(clumps[index].shade).multiply(new THREE.Color(1, 1.05, 0.9)),
    ),
  );

  // Woods on the horizon: tall cards of treetops all round, soft in the haze.
  const woods = painted(512, (context, size) => {
    context.clearRect(0, 0, size, size);
    const field = noiseField(21, 4);
    context.fillStyle = "#2f4f22";
    context.beginPath();
    context.moveTo(0, size);
    for (let x = 0; x <= size; x += 4) context.lineTo(x, size * (0.3 + field((x / size) * 7, 0.5) * 0.55));
    context.lineTo(size, size);
    context.closePath();
    context.fill();
    context.fillStyle = "#254019";
    for (let tree = 0; tree < 40; tree += 1) {
      const x = random() * size, top = size * (0.42 + random() * 0.35), width = size * (0.03 + random() * 0.04);
      context.beginPath();
      context.ellipse(x, top + width, width, width * 1.4, 0, 0, Math.PI * 2);
      context.fill();
    }
  });
  const treeline = new THREE.MeshBasicMaterial({ map: woods, alphaTest: 0.4, side: THREE.DoubleSide, color: 0x9ab892 });
  scenery.add(
    crowd(new THREE.PlaneGeometry(26, 12), treeline, 22, (index, object) => {
      const angle = (index / 22) * Math.PI * 2 + random() * 0.1;
      const distance = 34 + random() * 6;
      object.position.set(Math.sin(angle) * distance, BODY.floor + 5.2, Math.cos(angle) * distance);
      object.rotation.y = angle + Math.PI;
    }),
  );

  // Clouds, high and far, drifting nowhere.
  const puff = painted(256, (context, size) => {
    context.clearRect(0, 0, size, size);
    for (let blob = 0; blob < 14; blob += 1) {
      const x = size * (0.25 + random() * 0.5), y = size * (0.35 + random() * 0.3), r = size * (0.1 + random() * 0.14);
      const glow = context.createRadialGradient(x, y, 0, x, y, r);
      glow.addColorStop(0, "rgba(255,255,255,0.9)");
      glow.addColorStop(0.6, "rgba(255,255,255,0.45)");
      glow.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = glow;
      context.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  const cloud = new THREE.MeshBasicMaterial({ map: puff, transparent: true, depthWrite: false, fog: false, opacity: 0.85 });
  scenery.add(
    crowd(new THREE.PlaneGeometry(60, 30), cloud, 12, (index, object) => {
      const angle = random() * Math.PI * 2, distance = 90 + random() * 120;
      object.position.set(Math.sin(angle) * distance, 40 + random() * 45, Math.cos(angle) * distance);
      object.lookAt(0, 20, 0);
      object.scale.setScalar(0.8 + random() * 1.2);
    }),
  );

  // A park bench off to one side, and a lamp post.
  const iron = new THREE.MeshStandardMaterial({ color: 0x1e1f22, roughness: 0.6, metalness: 0.5 });
  const plank = new THREE.MeshStandardMaterial({ map: noiseTexture(128, 13, [0x6a4a2c, 0x9c7a50], { scale: 2, octaves: 3, repeat: 1 }), roughness: 0.8 });
  plank.map.repeat.set(4, 0.5);
  const bench = new THREE.Group();
  for (let slat = 0; slat < 3; slat += 1) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.04, 0.12), plank);
    seat.position.set(0, 0.45, -0.16 + slat * 0.16);
    seat.castShadow = true;
    bench.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.035), plank);
    back.position.set(0, 0.62 + slat * 0.15, 0.25);
    back.castShadow = true;
    bench.add(back);
  }
  for (const side of [-0.8, 0.8]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.4), iron);
    leg.position.set(side, 0.225, 0.02);
    bench.add(leg);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 0.06), iron);
    arm.position.set(side, 0.75, 0.25);
    bench.add(arm);
  }
  bench.position.set(-3.6, BODY.floor, -1.4);
  bench.rotation.y = 0.9;
  scenery.add(bench);
  const post = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 3.4, 10), iron);
  pole.position.y = 1.7;
  pole.castShadow = true;
  post.add(pole);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.4, 6), new THREE.MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xffe4a0, emissiveIntensity: 0.6, roughness: 0.4 }));
  lantern.position.y = 3.55;
  post.add(lantern);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.22, 6), iron);
  cap.position.y = 3.85;
  post.add(cap);
  post.position.set(3.2, BODY.floor, -2.6);
  scenery.add(post);

  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(0xcfe3f5, 0x4d6b33, 0.7));
  const sun = shadows(new THREE.DirectionalLight(0xfff0d0, 1.9), { near: 0.5, far: 12, bias: -0.0004, normalBias: 0.001 });
  sun.position.copy(sunDirection).multiplyScalar(1.4);
  sun.target.position.set(0, 0, -0.1);
  // A directional light's shadow covers a box; this one takes in the piano and the player.
  Object.assign(sun.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1.6 });
  lights.add(sun, sun.target);
  const bounce = new THREE.DirectionalLight(0xdfeeff, 0.35);
  bounce.position.set(1, 0.6, 1.5);
  lights.add(bounce, bounce.target);
  return { scenery, lights, keyLight: sun };
}

// A concert hall: a wooden stage under a proscenium, and beyond the piano
// the audience in red velvet seats, row on row up to the balcony, under
// sconces and a chandelier.
function hall() {
  const scenery = new THREE.Group();
  const random = seeded(11);
  const floorLevel = BODY.floor;
  const stallsLevel = floorLevel - 0.95;

  // The stage: planks, with its front edge dropping to the stalls.
  const planks = noiseTexture(512, 17, [0x4a2e18, 0x8a5c34], { scale: 2, octaves: 5, repeat: 1, speckle: 0.15 });
  const grained = painted(512, (context, size) => {
    context.drawImage(planks.image, 0, 0);
    context.fillStyle = "rgba(20, 10, 4, 0.55)";
    for (let line = 0; line < size; line += 32) context.fillRect(0, line, size, 2);
  }, { repeat: 1 });
  grained.repeat.set(6, 6);
  const stage = new THREE.Mesh(new THREE.BoxGeometry(24, 0.95, 7.6), new THREE.MeshPhysicalMaterial({ map: grained, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.4 }));
  stage.position.set(0, floorLevel - 0.475, 1);
  stage.receiveShadow = true;
  scenery.add(stage);
  const stallsFloor = new THREE.Mesh(new THREE.PlaneGeometry(30, 26), new THREE.MeshStandardMaterial({ color: 0x2a1410, roughness: 1 }));
  stallsFloor.rotation.x = -Math.PI / 2;
  stallsFloor.position.set(0, stallsLevel, -14);
  scenery.add(stallsFloor);

  // Seats in curved rows, and the people in them.
  const rows = 16;
  const perRow = 46;
  const seats = [];
  for (let row = 0; row < rows; row += 1) {
    const z = -3.6 - row * 0.95;
    const rise = stallsLevel + row * 0.17;
    for (let seat = 0; seat < perRow; seat += 1) {
      const x = (seat - (perRow - 1) / 2) * 0.58;
      if (Math.abs(x) < 0.7) continue; // the aisle
      const curve = (x * x) / 70;
      seats.push({ x, y: rise, z: z - curve, facing: -x / 40, taken: random() > 0.06 });
    }
  }
  const velvet = new THREE.MeshStandardMaterial({ color: 0x6b1a24, roughness: 0.92 });
  scenery.add(
    crowd(new THREE.BoxGeometry(0.5, 0.62, 0.1), velvet, seats.length, (index, object) => {
      const seat = seats[index];
      object.position.set(seat.x, seat.y + 0.62, seat.z - 0.24);
      object.rotation.y = seat.facing;
    }),
  );
  scenery.add(
    crowd(new THREE.BoxGeometry(0.48, 0.1, 0.44), velvet, seats.length, (index, object) => {
      const seat = seats[index];
      object.position.set(seat.x, seat.y + 0.4, seat.z);
      object.rotation.y = seat.facing;
    }),
  );
  const people = seats.filter((seat) => seat.taken).map((seat) => ({ seat, size: 0.9 + random() * 0.2, lean: (random() - 0.5) * 0.14, hair: random() }));
  const clothes = [0x1a1418, 0x2a1f2e, 0x102030, 0x3a2a1a, 0x141c14, 0x2b2b30, 0x4a1a1a, 0x1e2a3a, 0x5a4a3a, 0x202028].map((color) => new THREE.Color(color));
  const skins = [0xd8a07c, 0xb8865a, 0x7e4f30, 0x4a2c1c, 0xe8c0a0, 0x9a6a48].map((color) => new THREE.Color(color));
  const hairs = [0x141010, 0x2a1a10, 0x4a3320, 0x7a5a30, 0x9a8a80, 0x1a1a1e].map((color) => new THREE.Color(color));
  scenery.add(
    crowd(new THREE.CapsuleGeometry(0.2, 0.3, 4, 10), new THREE.MeshStandardMaterial({ roughness: 0.9 }), people.length, (index, object) => {
      const { seat, size, lean } = people[index];
      object.position.set(seat.x, seat.y + 0.68 * size, seat.z);
      object.rotation.set(0, seat.facing, lean);
      object.scale.set(size, size, size);
    }, (index) => clothes[Math.floor(random() * clothes.length)]),
  );
  scenery.add(
    crowd(new THREE.SphereGeometry(0.105, 12, 10), new THREE.MeshStandardMaterial({ roughness: 0.7 }), people.length, (index, object) => {
      const { seat, size, lean } = people[index];
      object.position.set(seat.x + lean * 0.4, seat.y + 1.06 * size, seat.z);
      object.scale.set(size, size * 1.15, size);
    }, () => skins[Math.floor(random() * skins.length)]),
  );
  scenery.add(
    crowd(new THREE.SphereGeometry(0.112, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ roughness: 0.85 }), people.length, (index, object) => {
      const { seat, size, lean, hair } = people[index];
      object.position.set(seat.x + lean * 0.4, seat.y + 1.06 * size + 0.01, seat.z);
      object.scale.set(size, size * (0.9 + hair * 0.5), size);
    }, () => hairs[Math.floor(random() * hairs.length)]),
  );

  // The house: a proscenium round the stage, panelled walls with sconces, a
  // balcony curving across the back with lamps along its rail, a chandelier.
  const plaster = new THREE.MeshStandardMaterial({ map: noiseTexture(256, 23, [0x3a1e16, 0x5a3626], { scale: 3, octaves: 4, repeat: 3 }), roughness: 0.9 });
  const gilt = new THREE.MeshPhysicalMaterial({ color: 0xc9a24a, roughness: 0.3, metalness: 0.7 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffc070, emissiveIntensity: 2.6, roughness: 0.5 });
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1, 9, 1), plaster);
    pillar.position.set(side * 9, floorLevel + 3.5, -2.2);
    scenery.add(pillar);
    const flute = new THREE.Mesh(new THREE.BoxGeometry(0.16, 8.6, 1.06), gilt);
    flute.position.set(side * 9, floorLevel + 3.5, -2.2);
    scenery.add(flute);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.6, 12, 32), plaster);
    wall.position.set(side * 15.5, floorLevel + 5, -8);
    scenery.add(wall);
    for (let bay = 0; bay < 6; bay += 1) {
      const pilaster = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.7), plaster);
      pilaster.position.set(side * 15.1, floorLevel + 2.5, -4 - bay * 4);
      scenery.add(pilaster);
      const sconce = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), lamp);
      sconce.position.set(side * 14.9, floorLevel + 3.1, -6 - bay * 4);
      scenery.add(sconce);
    }
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(19, 1.6, 1), plaster);
  lintel.position.set(0, floorLevel + 8.2, -2.2);
  scenery.add(lintel);
  const lintelTrim = new THREE.Mesh(new THREE.BoxGeometry(19, 0.12, 1.06), gilt);
  lintelTrim.position.set(0, floorLevel + 7.45, -2.2);
  scenery.add(lintelTrim);

  const balconyLamps = [];
  for (let segment = 0; segment < 15; segment += 1) {
    const angle = ((segment - 7) / 7) * 0.62;
    const radius = 22;
    const x = Math.sin(angle) * radius;
    const z = 4 - Math.cos(angle) * radius;
    const front = new THREE.Mesh(new THREE.BoxGeometry(2.05, 1.2, 0.5), plaster);
    front.position.set(x, floorLevel + 4.6, z);
    front.rotation.y = -angle;
    scenery.add(front);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.08, 0.1), gilt);
    rail.position.set(x, floorLevel + 5.24, z + 0.22);
    rail.rotation.y = -angle;
    scenery.add(rail);
    if (segment % 2 === 0) {
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), lamp);
      glow.position.set(x, floorLevel + 5.4, z + 0.3);
      scenery.add(glow);
      balconyLamps.push([x, floorLevel + 5.4, z + 0.3]);
    }
  }
  const balconyDeck = new THREE.Mesh(new THREE.BoxGeometry(34, 0.5, 8), plaster);
  balconyDeck.position.set(0, floorLevel + 3.95, -21);
  scenery.add(balconyDeck);
  const back = new THREE.Mesh(new THREE.BoxGeometry(34, 14, 0.6), new THREE.MeshStandardMaterial({ map: noiseTexture(256, 29, [0x2a0c0c, 0x4a1818], { scale: 1, octaves: 3, repeat: 6 }), roughness: 1 }));
  back.position.set(0, floorLevel + 6, -25);
  scenery.add(back);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(34, 34), new THREE.MeshStandardMaterial({ color: 0x1a100c, roughness: 1 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, floorLevel + 12, -10);
  scenery.add(ceiling);
  const chandelier = new THREE.Group();
  for (let tier = 0; tier < 3; tier += 1) {
    const ring = 8 + tier * 6;
    for (let bulb = 0; bulb < ring; bulb += 1) {
      const angle = (bulb / ring) * Math.PI * 2;
      const drop = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), lamp);
      drop.position.set(Math.sin(angle) * (0.5 + tier * 0.45), -tier * 0.4, Math.cos(angle) * (0.5 + tier * 0.45));
      chandelier.add(drop);
    }
  }
  const boss = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), gilt);
  chandelier.add(boss);
  chandelier.position.set(0, floorLevel + 10.4, -11);
  scenery.add(chandelier);

  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(0xffe0c0, 0x201410, 0.3));
  const key = shadows(spot(0xffd0a0, 3.6, [-0.6, 0.55, 0.05], [0, 0, -0.04]));
  lights.add(key, key.target);
  const rim = spot(0xffe6c8, 3.2, [0.5, 0.4, -0.6], [0, 0.02, 0], { angle: Math.PI / 5, penumbra: 0.9, distance: 3 });
  lights.add(rim, rim.target);
  // House lights, low, so the crowd is seen and not lit: the chandelier and a few along the balcony.
  const chandelierLight = new THREE.PointLight(0xffc080, 40, 30, 1.6);
  chandelierLight.position.set(0, floorLevel + 9.8, -11);
  lights.add(chandelierLight);
  for (const [x, y, z] of [balconyLamps[1], balconyLamps[4], balconyLamps[6]].filter(Boolean)) {
    const house = new THREE.PointLight(0xffb070, 6, 14, 1.5);
    house.position.set(x, y - 0.3, z + 1);
    lights.add(house);
  }
  return { scenery, lights, keyLight: key };
}

const SETS = { stage, park, hall };

// Builds the place a scene spec names. The stage owns what comes back and
// disposes of it when the place changes.
export function createPlace(spec) {
  const build = SETS[spec?.set] ?? stage;
  const place = build();
  place.dispose = () => {
    place.scenery.traverse((object) => {
      object.geometry?.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material) continue;
        material.map?.dispose();
        material.dispose();
      }
    });
    place.lights.traverse((object) => object.shadow?.map?.dispose());
  };
  return place;
}
