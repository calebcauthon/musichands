// Reads the joint layout out of a rigged hand model (binary glTF) without any
// 3D library, so the pose solver and its tests can share the renderer's exact
// skeleton. Joints follow the WebXR hand convention: each joint's -Z axis runs
// along its bone toward the fingertip, +Y points out of the back of the hand,
// and flexing a joint is a turn about its X axis.
import { mat4 } from "./rig-math.js";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

export const FINGER_JOINTS = {
  1: ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  2: ["index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip"],
  3: ["middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip"],
  4: ["ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip"],
  5: ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip"],
};

export function readGlbJson(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("Not a binary glTF file");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK) throw new Error("Binary glTF is missing its JSON chunk");
  const bytes = new Uint8Array(arrayBuffer, 20, length);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Returns every joint's rest matrix in wrist space, plus the wrist's own
// matrix in the model's space so a renderer can map back.
export function readSkeleton(arrayBuffer) {
  const json = readGlbJson(arrayBuffer);
  const joints = new Map();
  for (const node of json.nodes) {
    if (!node.name || node.mesh !== undefined) continue;
    const matrix = mat4.compose(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1]);
    joints.set(node.name, matrix);
  }
  const wrist = joints.get("wrist");
  if (!wrist) throw new Error("Hand model has no wrist joint");
  const wristInverse = mat4.invertRigid(wrist);
  const rest = {};
  for (const names of [["wrist"], ...Object.values(FINGER_JOINTS)]) {
    for (const name of names) {
      const matrix = joints.get(name);
      if (!matrix) throw new Error(`Hand model is missing joint ${name}`);
      rest[name] = mat4.multiply(wristInverse, matrix);
    }
  }
  return { rest, wrist, wristInverse };
}
