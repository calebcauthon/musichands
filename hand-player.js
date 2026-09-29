// Plays a set of notes through the hand and the piano together: all at once,
// or one finger after another.

export const PLAY_MODES = ["together", "succession"];
const STEP = 520; // ms between fingers when playing one by one
const RING = { together: 1500, succession: 620 }; // ms each note sounds
const HOLD = { together: 1300, succession: 700 }; // ms the last keys stay down

// When each group of notes goes down, in milliseconds from the start.
export function planNotes(midis, mode) {
  const notes = [...new Set([...midis].map(Number))].sort((a, b) => a - b);
  if (!notes.length) return [];
  if (mode === "together") return [{ at: 0, midis: notes, ring: RING.together, hold: HOLD.together }];
  return notes.map((midi, index) => ({ at: index * STEP, midis: [midi], ring: RING.succession, hold: index === notes.length - 1 ? HOLD.succession : STEP }));
}

export class HandPlayer {
  // press(midis) puts those fingers down and returns how many milliseconds
  // until the keys land; release() lifts them again.
  constructor({ press, release, audio, onChange = () => {} }) {
    this.press = press;
    this.release = release;
    this.audio = audio;
    this.onChange = onChange;
    this.timers = [];
    this.mode = null;
  }

  get playing() {
    return this.mode !== null;
  }

  play(midis, mode) {
    this.stop();
    const steps = planNotes(midis, mode);
    if (!steps.length) return;
    this.mode = mode;
    this.onChange(mode);
    for (const step of steps) {
      this.timers.push(
        setTimeout(() => {
          const landing = this.press(step.midis) ?? 0;
          for (const midi of step.midis) this.audio.noteOn(midi, { delay: landing, duration: step.ring });
        }, step.at),
      );
    }
    const last = steps.at(-1);
    this.timers.push(setTimeout(() => this.finish(), last.at + last.hold + 320));
  }

  finish() {
    this.timers = [];
    this.mode = null;
    this.release();
    this.onChange(null);
  }

  stop() {
    if (!this.playing) return;
    for (const timer of this.timers) clearTimeout(timer);
    this.audio.releaseAll();
    this.finish();
  }
}
