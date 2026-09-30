// Where the camera sits as it is turned around the hands. Angles are in
// degrees: azimuth 0 looks from the player's side, positive swings round to
// the player's right; elevation 90 looks straight down. Zoom 2 is twice as
// close as the stage would otherwise frame the hands.

export const ORBIT_LIMITS = { azimuth: [-150, 150], elevation: [6, 89], zoom: [0.05, 2.8] };
export const ZOOM_STEP = 1.18; // how much one press of a zoom button moves the camera
const TURN = { azimuth: 0.35, elevation: 0.28 }; // degrees for each pixel dragged
export const DRAG_THRESHOLD = 7; // pixels a press may wander and still count as a click

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));
const radians = (degrees) => (degrees * Math.PI) / 180;

// The camera's position for a view of `target` from `distance` away.
export function orbitPosition(target, distance, { azimuth, elevation }) {
  const flat = Math.cos(radians(elevation)) * distance;
  return [
    target[0] + Math.sin(radians(azimuth)) * flat,
    target[1] + Math.sin(radians(elevation)) * distance,
    target[2] + Math.cos(radians(azimuth)) * flat,
  ];
}

// How far back the camera must sit to keep a patch of the keyboard in frame.
// The patch is `width` along the keys and `depth` from the fallboard toward the
// player; turning the camera swaps how much of each runs across the picture.
export function framingDistance({ width, depth }, { azimuth, elevation }, { vertical, aspect }) {
  const [sin, cos] = [Math.abs(Math.sin(radians(azimuth))), Math.abs(Math.cos(radians(azimuth)))];
  const across = width * cos + depth * sin;
  const away = (width * sin + depth * cos) * Math.sin(radians(elevation));
  const halfHeight = Math.tan(radians(vertical) / 2);
  return Math.max(across / (2 * halfHeight * aspect), away / (2 * halfHeight));
}

// The view after dragging by (dx, dy) pixels from `start`. Dragging right
// swings the camera left, so the scene follows the pointer; dragging down
// lifts the camera toward overhead.
export function dragOrbit(start, dx, dy) {
  return {
    azimuth: clamp(start.azimuth - dx * TURN.azimuth, ORBIT_LIMITS.azimuth),
    elevation: clamp(start.elevation + dy * TURN.elevation, ORBIT_LIMITS.elevation),
    zoom: start.zoom ?? 1,
  };
}

// The view from `factor` times closer, or farther if it is below one.
export function zoomView(view, factor) {
  return { ...view, zoom: clamp((view.zoom ?? 1) * factor, ORBIT_LIMITS.zoom) };
}

export function sameView(a, b, tolerance = 0.5) {
  return (
    Math.abs(a.azimuth - b.azimuth) <= tolerance &&
    Math.abs(a.elevation - b.elevation) <= tolerance &&
    Math.abs((a.zoom ?? 1) / (b.zoom ?? 1) - 1) <= 0.02
  );
}

// A view this camera can take, from whatever was stored, or null.
export function cleanView(view) {
  if (!Number.isFinite(view?.azimuth) || !Number.isFinite(view?.elevation)) return null;
  return {
    azimuth: clamp(view.azimuth, ORBIT_LIMITS.azimuth),
    elevation: clamp(view.elevation, ORBIT_LIMITS.elevation),
    zoom: clamp(Number.isFinite(view.zoom) ? view.zoom : 1, ORBIT_LIMITS.zoom),
  };
}

export function readView(text) {
  try {
    return cleanView(JSON.parse(text));
  } catch {
    return null;
  }
}
