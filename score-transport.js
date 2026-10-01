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
  constructor({ steps, tempo, reach, perform, schedule = null, cancelScheduled = () => {}, lookAhead = 300, done = () => {}, tail = () => 0, now = () => performance.now(), setTimer = (run, ms) => setTimeout(run, ms), clearTimer = (id) => clearTimeout(id) }) {
    Object.assign(this, { steps, tempo, reach, perform, schedule, cancelScheduled, lookAhead, done, tail, now, setTimer, clearTimer });
    this.playing = false;
    this.timer = null;
    this.anchor = null; // a step's score time pinned to a moment on the clock
    this.index = 0;
    this.last = 0; // the last step to play
    this.loop = null; // { from, to }: score times; when `to` falls due the passage starts again from `from`
    this.audioTimer = null;
  }

  // The moment on the clock when a score time falls due.
  due(time) {
    return this.anchor.at + ((time - this.anchor.time) * 60000) / this.tempo();
  }

  // Plays from step `index` to the end, or to step `last`. With `loop`, the
  // passage between the score times `loop.from` and `loop.to` plays over and
  // over, each go starting on the beat the last one ended on.
  start(index = 0, { last = null, loop = null } = {}) {
    this.stop();
    const steps = this.steps();
    if (!steps.length) return;
    this.last = last === null ? steps.length - 1 : Math.min(Math.max(0, last), steps.length - 1);
    this.index = Math.min(Math.max(0, index), this.last);
    this.first = this.index;
    this.loop = loop;
    this.playing = true;
    // The first notes land once the hands have had time to reach them.
    this.anchor = { time: steps[this.index].time, at: this.now() + this.reach() };
    this.audioIndex = this.index;
    this.queueAudio();
    this.queue();
  }

  // Feed the audio clock independently of animation and DOM work. Even if a
  // frame stalls, notes already queued in Web Audio keep their original beat.
  queueAudio() {
    if (!this.schedule || !this.playing) return;
    const steps = this.steps();
    const now = this.now();
    while (this.audioIndex <= this.last) {
      const beat = this.due(steps[this.audioIndex].time);
      if (beat > now + this.lookAhead) break;
      const index = this.audioIndex++;
      if (beat >= now - 30) this.schedule(index, Math.max(0, beat - this.now()));
    }
    if (this.audioIndex <= this.last) this.audioTimer = this.setTimer(() => this.queueAudio(), 25);
  }

  // The first step still to sound at score time `time`, within the passage.
  audioIndexAt(time) {
    const steps = this.steps();
    const index = steps.findIndex((step, at) => at >= this.first && at <= this.last && step.time > time + 1e-6);
    return index < 0 ? this.last + 1 : index;
  }

  rescheduleAudio() {
    if (!this.schedule || !this.playing) return;
    this.clearTimer(this.audioTimer);
    this.cancelScheduled();
    this.audioIndex = this.audioIndexAt(this.anchor.time + ((this.now() - this.anchor.at) * this.tempo()) / 60000);
    this.queueAudio();
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
    let index = this.index;
    let beat = this.due(steps[index].time);
    const wait = Math.max(0, beat - this.lead(index) - this.now());
    this.timer = this.setTimer(() => {
      if (!this.playing) return;
      // A late frame should show the current pose, not replay a backlog of
      // expired visual steps. Audio has its own queue and loses no notes here.
      if (this.schedule) {
        while (index + 1 <= this.last && this.due(steps[index + 1].time) - this.lead(index + 1) <= this.now()) index += 1;
        beat = this.due(steps[index].time);
      }
      this.perform(index, Math.max(0, beat - this.now()));
      if (!this.playing) return;
      if (index + 1 <= this.last) {
        this.index = index + 1;
        this.queue();
      } else if (this.loop) {
        this.index = this.last + 1;
        this.queueLoop();
      } else {
        // Let the last notes sound before calling it finished.
        this.timer = this.setTimer(() => this.finish(), Math.max(0, beat - this.now()) + this.tail(index));
      }
    }, wait);
  }

  // Once the passage has run its length, pin its start to that beat and go
  // again, asking for the first step when the hands need to set off for it.
  queueLoop() {
    const again = this.due(this.loop.to);
    const first = again + ((this.steps()[this.first].time - this.loop.from) * 60000) / this.tempo();
    this.timer = this.setTimer(() => {
      if (!this.playing) return;
      this.anchor = { time: this.loop.from, at: again };
      this.index = this.first;
      this.audioIndex = this.first;
      this.queueAudio();
      this.queue();
    }, Math.max(0, first - this.reach() - this.now()));
  }

  // Keep the place but follow a new tempo from here on.
  retime(previousTempo) {
    if (!this.playing) return;
    const now = this.now();
    // Where in the score "now" is, by the tempo that was in force.
    const time = this.anchor.time + ((now - this.anchor.at) * previousTempo) / 60000;
    this.anchor = { time, at: now };
    this.clearTimer(this.timer);
    this.clearTimer(this.audioTimer);
    this.cancelScheduled();
    this.audioIndex = this.audioIndexAt(time);
    this.queueAudio();
    if (this.index <= this.last) this.queue();
    else if (this.loop) this.queueLoop();
  }

  finish() {
    this.clearTimer(this.audioTimer);
    this.playing = false;
    this.timer = null;
    this.done();
  }

  stop() {
    if (!this.playing) return;
    this.clearTimer(this.timer);
    this.clearTimer(this.audioTimer);
    this.cancelScheduled();
    this.playing = false;
    this.timer = null;
  }
}
