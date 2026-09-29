// A sampled grand piano on the Web Audio API.
//
// One recording every minor third covers the keyboard; notes in between play
// the nearest recording slightly faster or slower. If the recordings cannot be
// loaded, a plain synthesised tone stands in so the keys are never silent.

const SAMPLE_NAMES = [
  "A0", "C1", "Ds1", "Fs1", "A1", "C2", "Ds2", "Fs2", "A2", "C3", "Ds3", "Fs3", "A3", "C4", "Ds4",
  "Fs4", "A4", "C5", "Ds5", "Fs5", "A5", "C6", "Ds6", "Fs6", "A6", "C7", "Ds7", "Fs7", "A7", "C8",
];
const PITCH_CLASS = { C: 0, Ds: 3, Fs: 6, A: 9 };

export const SAMPLES = SAMPLE_NAMES.map((name) => {
  const [, pitch, octave] = name.match(/^([A-G]s?)(\d)$/);
  return { name, midi: (Number(octave) + 1) * 12 + PITCH_CLASS[pitch] };
});

// The recording to use for a note, and how much to speed it up or slow it down.
export function nearestSample(midi) {
  let best = SAMPLES[0];
  for (const sample of SAMPLES) {
    if (Math.abs(sample.midi - midi) < Math.abs(best.midi - midi)) best = sample;
  }
  return { ...best, rate: 2 ** ((midi - best.midi) / 12) };
}

const RELEASE = 0.11; // seconds for a damped string to fall to about a third
const TOO_LATE = 400; // ms after which a note that could not start on time is dropped
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export class PianoAudio {
  constructor({ baseUrl = new URL("./assets/piano/", import.meta.url), enabled = true, context = null, volume = 1.8 } = {}) {
    this.baseUrl = baseUrl;
    this.enabled = enabled;
    this.volume = volume;
    this.context = null;
    this.files = new Map(); // sample name → promise of its bytes
    this.buffers = new Map(); // sample name → promise of its decoded audio, or null if it failed
    this.voices = new Set();
    this.started = null; // settles once a live audio clock is running
    if (context) {
      this.attach(context);
    } else if (typeof window !== "undefined") {
      for (const sample of SAMPLES) this.fetchSample(sample.name);
      // Browsers only let sound start from a user gesture, so wake up on the first one.
      const wake = () => this.wake();
      window.addEventListener("pointerdown", wake, { once: true, capture: true });
      window.addEventListener("keydown", wake, { once: true, capture: true });
    }
  }

  fetchSample(name) {
    if (!this.files.has(name)) {
      this.files.set(
        name,
        fetch(new URL(`${name}.mp3`, this.baseUrl)).then((response) => {
          if (!response.ok) throw new Error(`Piano sample ${name} is missing (${response.status})`);
          return response.arrayBuffer();
        }),
      );
      this.files.get(name).catch(() => {});
    }
    return this.files.get(name);
  }

  attach(context) {
    this.context = context;
    this.input = context.createGain();
    this.input.gain.value = this.volume;
    const output = context.createDynamicsCompressor();
    // Full chords are several times louder than one note; keep them from clipping.
    output.threshold.value = -12;
    output.ratio.value = 4;
    output.attack.value = 0.004;
    output.release.value = 0.2;
    this.input.connect(output);
    // A little room around the piano.
    const room = context.createConvolver();
    room.buffer = roomImpulse(context);
    const wet = context.createGain();
    wet.gain.value = 0.2;
    this.input.connect(room).connect(wet).connect(output);
    output.connect(context.destination);
  }

  wake() {
    if (!this.context) {
      const Context = window.AudioContext ?? window.webkitAudioContext;
      if (!Context) return null;
      this.attach(new Context({ latencyHint: "interactive" }));
      this.started = this.clockRunning();
    } else if (this.started && this.context.state !== "running" && !this.starting) {
      this.started = this.clockRunning();
    }
    for (const sample of SAMPLES) this.decode(sample.name);
    return this.context;
  }

  // Resolves once the audio clock is actually advancing, which can lag well
  // behind creating the context the first time sound is used.
  async clockRunning() {
    this.starting = true;
    try {
      await this.context.resume?.();
    } catch {
      // Not allowed yet; the next gesture will try again.
    }
    for (let tries = 0; tries < 300 && this.context.currentTime === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.starting = false;
  }

  decode(name) {
    if (!this.buffers.has(name)) {
      this.buffers.set(
        name,
        this.fetchSample(name)
          .then((bytes) => this.context.decodeAudioData(bytes.slice(0)))
          .catch((error) => {
            console.warn(`MusicHands: using a synthesised tone for ${name}.`, error);
            return null;
          }),
      );
    }
    return this.buffers.get(name);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  // delay and duration are in milliseconds. Without a duration the note rings
  // until noteOff, or until the string dies away on its own.
  noteOn(midi, { delay = 0, velocity = 0.75, duration = null } = {}) {
    if (!this.enabled) return;
    const context = this.wake();
    if (!context) return;
    const requested = context.currentTime + delay / 1000;
    const asked = this.started ? performance.now() : null;
    const sample = nearestSample(midi);
    const voice = { midi, startAt: requested, stopAt: duration === null ? null : requested + duration / 1000, cancelled: false, nodes: null };
    this.voices.add(voice);
    Promise.all([this.decode(sample.name), this.started]).then(([buffer]) => {
      if (voice.cancelled) return;
      if (asked !== null) {
        // The audio clock may not have been running when this was asked for, so
        // place the note by the wall clock: notes keep their spacing, and one
        // that has missed its moment by too much is dropped instead of piling
        // up with the notes after it.
        const waited = performance.now() - asked;
        if (waited - delay > TOO_LATE) {
          this.voices.delete(voice);
          return;
        }
        const shift = context.currentTime + Math.max(0, delay - waited) / 1000 - voice.startAt;
        if (Math.abs(shift) > 0.02) {
          voice.startAt += shift;
          if (voice.stopAt !== null) voice.stopAt += shift;
        }
      }
      // If loading took a moment, start as soon as possible rather than in the past.
      const when = Math.max(voice.startAt, context.currentTime);
      const level = 0.25 + 0.75 * clamp(velocity, 0, 1) ** 1.6;
      // A key struck again takes over from its own earlier sound, and rings at
      // least as long as that sound was going to: the key is still held down.
      for (const other of this.voices) {
        if (other === voice || other.midi !== midi || !other.nodes || other.startAt > when) continue;
        const end = other.released ?? other.stopAt;
        if (voice.stopAt !== null && end !== null && end !== undefined) voice.stopAt = Math.max(voice.stopAt, end);
        this.release(other, when, 0.03);
      }
      voice.startAt = when;
      voice.level = level;
      voice.nodes = buffer ? this.sampleVoice(buffer, sample.rate, level, when) : this.toneVoice(midi, level, when);
      voice.nodes.source.onended = () => this.voices.delete(voice);
      if (voice.stopAt !== null) this.release(voice, Math.max(voice.stopAt, when + 0.08));
    });
  }

  sampleVoice(buffer, rate, level, when) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(level, when);
    source.connect(gain).connect(this.input);
    source.start(when);
    return { source, gain, extras: [] };
  }

  toneVoice(midi, level, when) {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level * 0.5, when + 0.006);
    gain.gain.setTargetAtTime(0, when + 0.006, 0.7);
    const source = this.context.createOscillator();
    source.type = "triangle";
    source.frequency.value = frequency;
    const overtone = this.context.createOscillator();
    overtone.frequency.value = frequency * 2;
    const overtoneGain = this.context.createGain();
    overtoneGain.gain.value = 0.25;
    source.connect(gain);
    overtone.connect(overtoneGain).connect(gain);
    gain.connect(this.input);
    source.start(when);
    overtone.start(when);
    source.stop(when + 5);
    overtone.stop(when + 5);
    return { source, gain, extras: [overtone] };
  }

  release(voice, at = this.context.currentTime, time = RELEASE) {
    if (!voice.nodes) {
      // Still loading: remember when to stop once it starts.
      voice.stopAt = voice.stopAt === null ? at : Math.min(voice.stopAt, at);
      return;
    }
    if (voice.released !== undefined && voice.released <= at) return;
    voice.released = at;
    const { source, gain, extras } = voice.nodes;
    gain.gain.cancelScheduledValues(at);
    gain.gain.setValueAtTime(voice.level, at);
    gain.gain.setTargetAtTime(0, at, time);
    const end = at + time * 8;
    try {
      source.stop(end);
      for (const extra of extras) extra.stop(end);
    } catch {
      // Already stopped.
    }
  }

  noteOff(midi, { delay = 0 } = {}) {
    if (!this.context) return;
    const at = this.context.currentTime + delay / 1000;
    for (const voice of this.voices) {
      if (voice.midi !== midi) continue;
      // Let even the quickest tap sound for a moment.
      this.release(voice, Math.max(at, voice.startAt + 0.09));
    }
  }

  // Damp everything now, and drop notes that were scheduled but have not started.
  releaseAll({ except = [] } = {}) {
    if (!this.context) return;
    const keep = new Set(except);
    const now = this.context.currentTime;
    for (const voice of this.voices) {
      if (keep.has(voice.midi)) continue;
      if (voice.startAt > now + 0.01) {
        voice.cancelled = true;
        this.voices.delete(voice);
        if (voice.nodes) {
          voice.nodes.gain.disconnect();
          try {
            voice.nodes.source.stop();
          } catch {
            // Never started.
          }
        }
      } else {
        this.release(voice, now);
      }
    }
  }
}

function roomImpulse(context) {
  const seconds = 1.9;
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    let smooth = 0;
    for (let index = 0; index < length; index += 1) {
      const t = index / length;
      // Noise that darkens and fades, after a short gap for the first reflection.
      smooth += (Math.random() * 2 - 1 - smooth) * (0.55 - 0.4 * t);
      data[index] = index < context.sampleRate * 0.012 ? 0 : smooth * (1 - t) ** 3.2;
    }
  }
  return impulse;
}
