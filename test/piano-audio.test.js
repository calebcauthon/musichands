import assert from "node:assert/strict";
import test from "node:test";
import { PianoAudio } from "../piano-audio.js";

// Exercise the queue against a controllable audio clock without creating an
// audio device. The source start/stop calls are the Web Audio scheduling boundary.
function piano() {
  const audio = Object.create(PianoAudio.prototype);
  Object.assign(audio, { enabled: true, context: { currentTime: 10 }, started: null, voices: new Set() });
  audio.wake = () => audio.context;
  audio.decode = () => Promise.resolve({});
  const starts = [];
  audio.sampleVoice = (_buffer, _rate, _level, when) => {
    const record = { when, stops: [] };
    starts.push(record);
    return {
      source: { stop: (at) => record.stops.push(at), onended: null },
      gain: { disconnect() { record.disconnected = true; }, gain: { cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} } },
      extras: [],
    };
  };
  return { audio, starts };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("notes are submitted to the audio clock before their beat", async () => {
  const { audio, starts } = piano();
  for (let i = 0; i < 8; i++) audio.noteOn(60 + i, { delay: 100 + i * 31.25, duration: 31.25 });
  await settle();
  assert.deepEqual(starts.map((entry) => entry.when), Array.from({ length: 8 }, (_, i) => 10.1 + i * 0.03125));
});

test("retiming cancels future sources while an already sounding note keeps ringing", async () => {
  const { audio, starts } = piano();
  audio.noteOn(60);
  audio.noteOn(64, { delay: 250 });
  await settle();
  audio.context.currentTime = 10.1;
  audio.cancelScheduled();
  assert.equal(audio.voices.size, 1);
  assert.equal(starts[0].disconnected, undefined);
  assert.equal(starts[1].disconnected, true);
  assert.equal(starts[1].stops.length, 1);
});

test("a stopped buffered note cannot start when decoding completes later", async () => {
  const { audio, starts } = piano();
  let decoded;
  audio.decode = () => new Promise((resolve) => { decoded = resolve; });
  audio.noteOn(60, { delay: 250 });
  audio.cancelScheduled();
  decoded({});
  await settle();
  assert.equal(starts.length, 0);
  assert.equal(audio.voices.size, 0);
});
