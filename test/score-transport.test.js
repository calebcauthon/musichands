import assert from "node:assert/strict";
import test from "node:test";
import { ScoreTransport } from "../score-transport.js";

// A clock and timers that only move when told to.
function bench({ times, tempo = 120, reach = 300, buffered = false }) {
  let clock = 0;
  let timers = [];
  let nextId = 1;
  const state = { tempo, reach, log: [], audio: [], cancellations: [], finished: null };
  const transport = new ScoreTransport({
    steps: () => times.map((time) => ({ time })),
    tempo: () => state.tempo,
    reach: () => state.reach,
    tail: () => 500,
    perform: (index, landIn) => state.log.push({ index, asked: clock, lands: clock + landIn }),
    schedule: buffered ? (index, delay) => state.audio.push({ index, asked: clock, lands: clock + delay }) : null,
    cancelScheduled: () => state.cancellations.push(clock),
    done: () => (state.finished = clock),
    now: () => clock,
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.push({ id, run, at: clock + ms });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
  });
  const advance = (to) => {
    for (;;) {
      const next = timers.filter((timer) => timer.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((timer) => timer !== next);
      clock = Math.max(clock, next.at);
      next.run();
    }
    clock = to;
  };
  return { transport, state, advance, stall: (ms) => { clock += ms; } };
}

test("notes land on their beats at the tempo", () => {
  const { transport, state, advance } = bench({ times: [0, 1, 2, 2.5], tempo: 120, reach: 300 });
  transport.start(0);
  advance(5000);
  // At 120 a quarter note is 500 ms; the first note lands once the hands have reached it.
  assert.deepEqual(state.log.map((entry) => entry.lands), [300, 800, 1300, 1550]);
  assert.deepEqual(state.log.map((entry) => entry.index), [0, 1, 2, 3]);
  assert.equal(state.finished, 2050);
  assert.equal(transport.playing, false);
});

test("32 notes/second stay on time through a 200 ms blocked frame", () => {
  const run = bench({ times: Array.from({ length: 64 }, (_, i) => i / 8), tempo: 240, buffered: true });
  run.transport.start();
  run.advance(500);
  run.stall(200);
  run.advance(4000);
  assert.equal(run.state.audio.length, 64, "all notes scheduled, including ones whose visual frame was skipped");
  for (const note of run.state.audio) {
    assert.equal(note.lands, 300 + note.index * 31.25);
    assert.ok(note.asked <= note.lands, "audio submitted before its deadline");
  }
  assert.ok(run.state.log.length < 64, "expired poses are coalesced instead of replayed in a burst");
  assert.equal(run.state.log.at(-1).index, 63);
});

test("tempo changes cancel and replace future buffered notes without duplicates", () => {
  const run = bench({ times: [0, 0.25, 0.5, 0.75, 1], tempo: 120, reach: 200, buffered: true });
  run.transport.start();
  run.advance(325);
  run.state.tempo = 60;
  const cut = run.state.audio.length;
  run.transport.retime(120);
  run.advance(3000);
  assert.deepEqual(run.state.cancellations, [325]);
  assert.deepEqual(run.state.audio.slice(cut).map(({ index, lands }) => [index, lands]), [[2, 575], [3, 825], [4, 1075]]);
});

test("stopping cancels the audio pump and queued future notes", () => {
  const run = bench({ times: Array.from({ length: 32 }, (_, i) => i / 8), buffered: true });
  run.transport.start();
  run.advance(400);
  run.transport.stop();
  const count = run.state.audio.length;
  run.advance(5000);
  assert.equal(run.state.audio.length, count);
  assert.deepEqual(run.state.cancellations, [400]);
  assert.equal(run.state.finished, null);
});

test("each step is asked for ahead of its beat, by no more than the gap allows", () => {
  const { transport, state, advance } = bench({ times: [0, 1, 1.25], tempo: 120, reach: 300 });
  transport.start(0);
  advance(5000);
  const lead = state.log.map((entry) => entry.lands - entry.asked);
  assert.equal(lead[1], 300, "a quarter note apart leaves room for the full reach");
  assert.ok(Math.abs(lead[2] - 93.75) < 1e-9, "a sixteenth apart squeezes the move into three quarters of the gap");
});

test("faster reflexes start later but land on the same beat", () => {
  const slow = bench({ times: [0, 2], reach: 400 });
  const fast = bench({ times: [0, 2], reach: 100 });
  for (const { transport, advance } of [slow, fast]) {
    transport.start(0);
    advance(5000);
  }
  assert.equal(slow.state.log[1].lands - slow.state.log[0].lands, 1000);
  assert.equal(fast.state.log[1].lands - fast.state.log[0].lands, 1000);
  assert.equal(slow.state.log[1].lands - slow.state.log[1].asked, 400);
  assert.equal(fast.state.log[1].lands - fast.state.log[1].asked, 100);
});

test("playing can start part way through and be stopped", () => {
  const { transport, state, advance } = bench({ times: [0, 1, 2, 3] });
  transport.start(2);
  advance(400);
  transport.stop();
  advance(5000);
  assert.deepEqual(state.log.map((entry) => entry.index), [2]);
  assert.equal(state.finished, null);
});

test("a change of tempo takes effect from where the music is", () => {
  const { transport, state, advance } = bench({ times: [0, 1, 2, 3], tempo: 120, reach: 200 });
  transport.start(0);
  advance(700); // the second note lands at 700
  state.tempo = 60;
  transport.retime(120);
  advance(10000);
  assert.deepEqual(state.log.map((entry) => entry.lands), [200, 700, 1700, 2700]);
});

test("a passage plays to its last step and starts again on the beat", () => {
  // Steps at 0, 1, 2, 3, 4, 5: the passage is the measure from 1 to 3 (quarter notes), a rest before its first note.
  const { transport, state, advance } = bench({ times: [0, 1, 2, 3, 4, 5], tempo: 120, reach: 300, buffered: true });
  transport.start(1, { last: 2, loop: { from: 0.5, to: 2.5 } });
  advance(2900);
  // The first go: step 1 lands at 300, step 2 at 800. The passage is two quarter
  // notes long (1000 ms), so it starts again at 300 + 1000 - 250 (the half beat
  // of rest before step 1): step 1 lands again at 1300, step 2 at 1800...
  assert.deepEqual(state.log.map((entry) => [entry.index, entry.lands]), [[1, 300], [2, 800], [1, 1300], [2, 1800], [1, 2300], [2, 2800]]);
  assert.deepEqual(state.audio.map((entry) => [entry.index, entry.lands]), [[1, 300], [2, 800], [1, 1300], [2, 1800], [1, 2300], [2, 2800]]);
  assert.equal(state.finished, null, "a looping passage is never finished");
  assert.equal(transport.playing, true);
  transport.stop();
  advance(6000);
  assert.equal(state.log.length, 6, "stopping ends the loop");
});

test("a passage keeps looping through a tempo change", () => {
  const run = bench({ times: [0, 1, 2, 3], tempo: 120, reach: 100, buffered: true });
  run.transport.start(0, { last: 1, loop: { from: 0, to: 2 } });
  run.advance(1100); // step 0 at 100, step 1 at 600; the next go is due at 1100
  run.state.tempo = 60;
  run.transport.retime(120);
  run.advance(4000);
  const lands = run.state.log.map((entry) => [entry.index, entry.lands]);
  assert.deepEqual(lands.slice(0, 4), [[0, 100], [1, 600], [0, 1100], [1, 2100]], "the second go runs at the new tempo");
  assert.ok(!run.state.log.some((entry) => entry.index > 1), "nothing past the passage is played");
});

test("a range without a loop ends after its last step", () => {
  const { transport, state, advance } = bench({ times: [0, 1, 2, 3] });
  transport.start(1, { last: 2 });
  advance(5000);
  assert.deepEqual(state.log.map((entry) => entry.index), [1, 2]);
  assert.equal(state.finished, 300 + 500 + 500);
});
