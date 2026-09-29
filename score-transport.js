// Plays a score through at a tempo: works out when each step's notes should
// sound, and asks for each step a little ahead of its beat so the hands have
// time to get there.

const BREATH = 0.75; // at most this much of the gap since the last step is spent moving

export class ScoreTransport {
  // steps(): the score's steps, each with a time in quarter notes.
  // tempo(): quarter notes a minute.
  // reach(): how long, in ms, the hands like to take to reach a key.
  // perform(index, landIn): show step `index`, with its notes landing `landIn` ms from now.
  // done(): called when the last step has played out.
  constructor({ steps, tempo, reach, perform, done = () => {}, tail = () => 0, now = () => performance.now(), setTimer = (run, ms) => setTimeout(run, ms), clearTimer = (id) => clearTimeout(id) }) {
    Object.assign(this, { steps, tempo, reach, perform, done, tail, now, setTimer, clearTimer });
    this.playing = false;
    this.timer = null;
    this.anchor = null; // a step's score time pinned to a moment on the clock
    this.index = 0;
  }

  // The moment on the clock when a score time falls due.
  due(time) {
    return this.anchor.at + ((time - this.anchor.time) * 60000) / this.tempo();
  }

  start(index = 0) {
    this.stop();
    const steps = this.steps();
    if (!steps.length) return;
    this.index = Math.min(Math.max(0, index), steps.length - 1);
    this.first = this.index;
    this.playing = true;
    // The first notes land once the hands have had time to reach them.
    this.anchor = { time: steps[this.index].time, at: this.now() + this.reach() };
    this.queue();
  }

  // How far ahead of its beat a step is asked for.
  lead(index) {
    const steps = this.steps();
    if (index === this.first) return Math.max(0, this.due(steps[index].time) - this.now());
    const gap = this.due(steps[index].time) - this.due(steps[index - 1].time);
    return Math.min(this.reach(), gap * BREATH);
  }

  queue() {
    const steps = this.steps();
    const index = this.index;
    const beat = this.due(steps[index].time);
    const wait = Math.max(0, beat - this.lead(index) - this.now());
    this.timer = this.setTimer(() => {
      if (!this.playing) return;
      this.perform(index, Math.max(0, beat - this.now()));
      if (index + 1 < steps.length) {
        this.index = index + 1;
        this.queue();
      } else {
        // Let the last notes sound before calling it finished.
        this.timer = this.setTimer(() => this.finish(), Math.max(0, beat - this.now()) + this.tail(index));
      }
    }, wait);
  }

  // Keep the place but follow a new tempo from here on.
  retime(previousTempo) {
    if (!this.playing) return;
    const steps = this.steps();
    const now = this.now();
    // Where in the score "now" is, by the tempo that was in force.
    const time = this.anchor.time + ((now - this.anchor.at) * previousTempo) / 60000;
    this.anchor = { time, at: now };
    this.clearTimer(this.timer);
    if (this.index < steps.length) this.queue();
  }

  finish() {
    this.playing = false;
    this.timer = null;
    this.done();
  }

  stop() {
    if (!this.playing) return;
    this.clearTimer(this.timer);
    this.playing = false;
    this.timer = null;
  }
}
