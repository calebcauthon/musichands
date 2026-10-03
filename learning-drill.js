// The drill: the way of learning (see learning.js for the shape) in which
// nobody talks and nothing is asked. The plan is fixed (drill.js): each hand
// that plays is put in its position on the screen and held there, then the
// passage is played through slowly several times with a gap between, then
// faster, then at tempo; then the other hand; then both. The browser that
// leads goes through the steps by itself, writing where it is into the
// workspace's `lesson` as { mode: "drill", from, to, step, score } so every
// browser follows. The learner can pause, go back and play, skip a step, or
// stop; otherwise there is nothing to do but play along.
import { DRILL, drillPose, drillProgress, drillSteps } from "./drill.js";
import { backTime, cleanLesson, lessonRange, NO_LESSON, OVERHEAD, stageHands } from "./lesson.js";

const NO_POSE = { left: null, right: null };
const BACK_SECONDS = 5; // how far the back button goes

function mount(app, host) {
  const { root } = host;
  const panel = {
    root: root.querySelector("#drill"),
    kicker: root.querySelector("#drill-kicker"),
    progress: root.querySelector("#drill-progress"),
    status: root.querySelector("#drill-status"),
    pause: root.querySelector("#drill-pause"),
    back: root.querySelector("#drill-back"),
    top: root.querySelector("#drill-top"),
    skip: root.querySelector("#drill-skip"),
    stop: root.querySelector("#drill-stop"),
  };

  let lead = false; // this browser plays the music, so it goes through the steps
  let entered = null; // the step, by key, this browser has set up and started
  let timer = null; // the hold before playing, or the gap after it: { kind, ms, handle }
  let paused = false;
  let musicHeld = false; // the music was playing when the drill was paused
  let plan = null; // the steps of the passage being drilled: { key, steps }

  const keyOf = (lesson) => `${lesson.score ?? ""}:${lesson.from}-${lesson.to}:${lesson.step}`;
  const music = () => ({ score: app.score, events: app.events, positions: app.positions, tempo: app.scoreTempo });

  // The lesson the workspace holds, if it is this module's, on the piece that is open.
  function current(state = app.state) {
    const lesson = cleanLesson(state?.lesson);
    return lesson?.mode === "drill" && app.score && (!lesson.score || lesson.score === state.score?.id) ? lesson : null;
  }

  // The plan for the passage, worked out once.
  function stepsOf(lesson) {
    const key = `${app.state?.score?.id ?? ""}:${lesson.from}-${lesson.to}:${app.scoreTempo}`;
    if (plan?.key !== key) plan = { key, steps: drillSteps(lesson, music(), DRILL) };
    return plan.steps;
  }
  const stepOf = (lesson) => (lesson ? stepsOf(lesson)[Number(lesson.step) || 0] ?? null : null);

  // -------------------------------------------------------------------------
  // Going through the steps

  async function start({ from, to }) {
    const lesson = { mode: "drill", from, to, step: 0, score: app.state.score?.id ?? "" };
    const range = lessonRange(lesson, app.score.measures);
    app.change({ lesson, passage: { from, to, times: 1, start: null, end: null }, time: range.start, playing: false, tempo: null, pose: NO_POSE, hands: stageHands("both"), camera: { view: { ...OVERHEAD }, autoCut: false } });
  }

  function wait(kind, ms, then) {
    clearTimer();
    timer = { kind, ms, handle: setTimeout(() => {
      timer = null;
      then();
    }, ms) };
  }

  function clearTimer() {
    if (timer) clearTimeout(timer.handle);
    timer = null;
  }

  // Sets the screen up for the step and starts it: a position held, or the
  // passage played once.
  function enterStep(lesson) {
    clearTimer();
    paused = false;
    const step = stepOf(lesson);
    if (!step) return finish();
    const range = lessonRange(lesson, app.score.measures);
    const pose = step.kind === "show" ? drillPose(step.stage, lesson, music()) : NO_POSE;
    app.change({ passage: { from: lesson.from, to: lesson.to, times: 1, start: null, end: null }, hands: stageHands(step.stage), tempo: step.tempo, time: range.start, playing: false, pose });
    if (step.kind === "show") wait("hold", step.hold, next);
    else app.playFrom(range.start);
    paint();
  }

  function next() {
    const lesson = current();
    if (!lesson) return;
    clearTimer();
    app.change({ lesson: { ...lesson, step: (Number(lesson.step) || 0) + 1 }, playing: false }); // set up by show()
  }

  function finish() {
    clearTimer();
    app.change(NO_LESSON);
  }

  // What was playing has played out: a gap, then the next time through.
  app.addEventListener("played", () => {
    const lesson = current();
    if (!lesson || !lead) return;
    const step = stepOf(lesson);
    if (!step) return;
    wait("gap", step.gap ?? DRILL.gap, next);
    paint();
  });

  // -------------------------------------------------------------------------
  // The learner's hand on it: pause, back a little, from the top, skip, stop

  function pauseOrResume() {
    if (!current()) return;
    if (paused) {
      paused = false;
      if (musicHeld && !app.state.playing) app.togglePlaying();
      else if (timer?.held) {
        const { kind, ms } = timer;
        timer = null;
        wait(kind, ms, next);
      }
    } else {
      paused = true;
      musicHeld = Boolean(app.state.playing);
      if (musicHeld) app.change({ playing: false });
      if (timer) {
        // The wait is kept, to be begun again when the drill goes on.
        clearTimeout(timer.handle);
        timer = { ...timer, held: true };
      }
    }
    paint();
  }

  // Plays from a little before where it is, or from the top; always plays.
  // A hold or a gap is dropped: when this playing ends, the gap comes.
  function playBack(seconds) {
    const lesson = current();
    if (!lesson) return;
    const { start } = lessonRange(app.state.passage ?? lesson, app.score.measures);
    const time = seconds === null ? start : backTime(app.state.time, seconds, app.tempo, start);
    paused = false;
    clearTimer();
    app.playFrom(time);
    paint();
  }

  function stop() {
    if (!current()) return;
    finish();
  }

  // -------------------------------------------------------------------------
  // The panel

  function paint(state = app.state) {
    const lesson = current(state);
    panel.root.hidden = !lesson;
    if (!lesson) return;
    const range = lessonRange(lesson, app.score.measures);
    const steps = stepsOf(lesson);
    const step = stepOf(lesson);
    panel.kicker.textContent = `${range.from === range.to ? `Drilling measure ${range.from}` : `Drilling measures ${range.from}–${range.to}`} · ${drillProgress(step, steps)}`;
    panel.progress.textContent = step ? (step.kind === "play" ? `${step.label} · ${step.time} of ${step.times}` : step.label) : "Done";
    let status = "";
    if (step?.kind === "show") status = "Put your hand where the screen has it.";
    else if (state.playing) status = "Play along.";
    else if (timer?.kind === "gap") status = "Again in a moment…";
    if (paused) status = "Paused. Press Play to carry on.";
    if (!lead) status = status || "Following along.";
    panel.status.textContent = status;
    panel.pause.textContent = paused ? "▶ Play" : "⏸ Pause";
    panel.pause.setAttribute("aria-pressed", String(paused));
  }

  function show({ state, lesson, lead: leads }) {
    lead = Boolean(leads);
    const key = keyOf(lesson);
    if (lead && entered !== key) {
      entered = key;
      enterStep(lesson);
    }
    paint(state);
  }

  function leave() {
    clearTimer();
    paused = false;
    entered = null;
    paint();
  }

  // G skips to the next step.
  function key(event, { onControl }) {
    if (onControl || !current()) return false;
    if (event.key === "g" || event.key === "G") {
      next();
      return true;
    }
    return false;
  }

  panel.pause.addEventListener("click", pauseOrResume);
  panel.back.addEventListener("click", () => playBack(BACK_SECONDS));
  panel.top.addEventListener("click", () => playBack(null));
  panel.skip.addEventListener("click", next);
  panel.stop.addEventListener("click", stop);

  return { start, show, leave, stop, key, discard: () => {}, next };
}

export default {
  id: "drill",
  name: "Drill",
  blurb: "Nobody talks: each hand placed, played slowly four times, then faster; then both.",
  available: () => true,
  mount,
};
