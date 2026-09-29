// Saved camera positions, and when to cut between them while music plays.
import { cleanView, sameView } from "./camera-orbit.js";

export const MAX_SHOTS = 9;
export const SHOT_LENGTH = 3200; // ms a shot is held at least before the next cut

// Views to start from, until the player saves their own.
export const STARTER_SHOTS = [
  { azimuth: 0, elevation: 72, zoom: 1 }, // the player's own view
  { azimuth: -40, elevation: 36, zoom: 1.25 }, // low, from the bass end
  { azimuth: 0, elevation: 87, zoom: 1.35 }, // straight down, close
  { azimuth: 44, elevation: 32, zoom: 1.2 }, // low, from the treble end
];

export function readShots(text) {
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return null;
    return list.map(cleanView).filter(Boolean).slice(0, MAX_SHOTS);
  } catch {
    return null;
  }
}

export class ShotList {
  constructor(views = STARTER_SHOTS) {
    this.views = views.map((view) => ({ ...view }));
    this.at = -1; // the shot last cut to
  }

  get length() {
    return this.views.length;
  }

  get full() {
    return this.views.length >= MAX_SHOTS;
  }

  // Returns the place of the saved view, or of one already saved that matches it.
  add(view) {
    const existing = this.views.findIndex((saved) => sameView(saved, view));
    if (existing !== -1) return existing;
    if (this.full) return -1;
    this.views.push({ ...view });
    return this.views.length - 1;
  }

  remove(index) {
    if (index < 0 || index >= this.views.length) return;
    this.views.splice(index, 1);
    if (this.at >= index) this.at -= 1;
  }

  // The next shot to cut to, skipping the view the camera is already on.
  next(current = null) {
    if (!this.views.length) return null;
    for (let tries = 0; tries < this.views.length; tries += 1) {
      this.at = (this.at + 1) % this.views.length;
      if (!current || this.views.length === 1 || !sameView(this.views[this.at], current)) break;
    }
    return { ...this.views[this.at] };
  }
}

// Cuts fall on the first beat of a measure, once the current shot has had its time.
export function dueForCut({ now, lastCut, shots, measureStarted }) {
  return measureStarted && shots >= 2 && now - lastCut >= SHOT_LENGTH;
}
