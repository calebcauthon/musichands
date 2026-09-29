import assert from "node:assert/strict";
import test from "node:test";
import { ScoreTransport } from "../score-transport.js";

// A clock and timers that only move when told to.
function bench({ times, tempo = 120, reach = 300 }) {
  let clock = 0;
  let timers = [];
  let nextId = 1;
  const state = { tempo, reach, log: [], finished: null };
  const transport = new ScoreTransport({
    steps: () => times.map((time) => ({ time })),
    tempo: () => state.tempo,
    reach: () => state.reach,
    tail: () => 500,
    perform: (index, landIn) => state.log.push({ index, asked: clock, lands: clock + landIn }),
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
      clock = next.at;
      next.run();
    }
    clock = to;
  };
  return { transport, state, advance };
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
