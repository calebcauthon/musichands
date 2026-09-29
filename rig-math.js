// Small vector and rigid-transform helpers for the hand rig. Matrices are
// 16-element arrays in column-major order, the same layout three.js uses.

export const vec3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  distance: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  normalize: (a) => {
    const length = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / length, a[1] / length, a[2] / length];
  },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

export const mat4 = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],

  // Rigid transform from a translation and a unit quaternion [x, y, z, w].
  compose(t, q) {
    // Stored quaternions are only unit length to single precision.
    const norm = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    const [x, y, z, w] = q.map((value) => value / norm);
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
      2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
      2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
      t[0], t[1], t[2], 1,
    ];
  },

  multiply(a, b) {
    const out = new Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        out[column * 4 + row] =
          a[row] * b[column * 4] +
          a[4 + row] * b[column * 4 + 1] +
          a[8 + row] * b[column * 4 + 2] +
          a[12 + row] * b[column * 4 + 3];
      }
    }
    return out;
  },

  // Inverse of a rotation-plus-translation matrix.
  invertRigid(m) {
    const t = [m[12], m[13], m[14]];
    return [
      m[0], m[4], m[8], 0,
      m[1], m[5], m[9], 0,
      m[2], m[6], m[10], 0,
      -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]),
      -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]),
      -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]),
      1,
    ];
  },

  translation: (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1],

  scaling: (s) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1],

  // Rotation by `angle` about a unit `axis` through the origin.
  rotation(axis, angle) {
    const [x, y, z] = axis;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const k = 1 - c;
    return [
      c + x * x * k, y * x * k + z * s, z * x * k - y * s, 0,
      x * y * k - z * s, c + y * y * k, z * y * k + x * s, 0,
      x * z * k + y * s, y * z * k - x * s, c + z * z * k, 0,
      0, 0, 0, 1,
    ];
  },

  // Rotation by `angle` about a unit `axis` passing through `point`.
  rotationAbout(point, axis, angle) {
    const m = mat4.rotation(axis, angle);
    m[12] = point[0] - (m[0] * point[0] + m[4] * point[1] + m[8] * point[2]);
    m[13] = point[1] - (m[1] * point[0] + m[5] * point[1] + m[9] * point[2]);
    m[14] = point[2] - (m[2] * point[0] + m[6] * point[1] + m[10] * point[2]);
    return m;
  },

  transformPoint: (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ],

  transformDirection: (m, d) => [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ],

  position: (m) => [m[12], m[13], m[14]],
  axisX: (m) => [m[0], m[1], m[2]],
  axisY: (m) => [m[4], m[5], m[6]],
  axisZ: (m) => [m[8], m[9], m[10]],
};
