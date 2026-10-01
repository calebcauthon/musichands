// Learning mode, as a module on the sheet page. It is handed the page's `app`
// interface (the seam at the foot of sheet.js) and uses nothing else of the
// page: it reads the music and the workspace through it, and does everything
// it does by changing the workspace's public fields — tempo, hands, time,
// camera, pose, passage, playing — as an agent could. A lesson is a plan of
// steps (lesson.js): where the site has a writer, the plan is designed and
// written for the passage (lesson-writer.js); otherwise it is the ready-made
// one. This file is the Learn button, choosing the measures, the lesson
// panel, the voice, and going through the plan a step at a time.
//
// The lesson under way is kept in the workspace as `lesson`. The workspace
// stores it as given and never reads it, so the shape of a lesson can change
// here without touching the page or the server.
import { advanceLesson, cleanLesson, defaultLesson, describeAdvance, describeNext, describeProgress, lessonPassage, lessonRange, OVERHEAD, readyMadePlan, stageHands } from "./lesson.js";
import { lessonBrief, planFromScript, shownText, writerRequest } from "./lesson-writer.js";
import { Narrator } from "./speech.js";

const NO_POSE = { left: null, right: null };
const WRITER_WAIT = 60000; // ms a lesson waits to be written before the ready-made one steps in
const keyOf = (lesson) => (lesson ? `${lesson.from}-${lesson.to}:${lesson.step}` : null);

export function mountLearning(app, root = document) {
  const learnButton = root.querySelector("#learn");
  const panel = {
    root: root.querySelector("#lesson"),
    kicker: root.querySelector("#lesson-kicker"),
    progress: root.querySelector("#lesson-progress"),
    caption: root.querySelector("#lesson-caption"),
    next: root.querySelector("#lesson-next"),
    stop: root.querySelector("#lesson-stop"),
    play: root.querySelector("#lesson-play"),
    restart: root.querySelector("#lesson-restart"),
    again: root.querySelector("#lesson-again"),
  };
  const pick = { root: root.querySelector("#lesson-pick"), text: root.querySelector("#lesson-pick-text"), start: root.querySelector("#lesson-start"), cancel: root.querySelector("#lesson-cancel") };

  let picking = null; // choosing the measures: { from, to, anchor }; anchor is the end clicked first, while the other is awaited
  let seen; // the lesson, by key, last laid on the screen
  let scoreSeen = null; // the piece that was open then
  let opening = true; // the workspace has only just been opened: nothing has been laid on the screen yet

  let turn = 0; // which narration is the one going on; a later one, or a stop, overtakes it
  let planned = null; // the plan for the passage being learnt: { key, plan (a promise), ready (the plan, once it is there) }

  // The panel shows what has been said in the phase so far, a line at a
  // time, without the directions written into a line for the voice.
  const voice = new Narrator({
    fetchSpeech: (text) => app.speech(text),
    onLine: (line) => {
      const words = shownText(line);
      panel.caption.textContent = panel.caption.textContent ? `${panel.caption.textContent} ${words}` : words;
    },
  });
  function sayAfresh(lines) {
    voice.stop();
    panel.caption.textContent = "";
    return voice.sayAll(Array.isArray(lines) ? lines : [lines]);
  }

  // The lesson the workspace holds, if it is one on the piece that is open.
  function current(state = app.state) {
    const lesson = cleanLesson(state?.lesson);
    return lesson && app.score && (!lesson.score || lesson.score === state.score?.id) ? lesson : null;
  }

  // The plan for a lesson's passage, asked for once: designed and written
  // for the passage where the site has a writer, else (or if that fails, or
  // takes too long) the ready-made one. Always comes to a plan.
  function planning(lesson) {
    const music = { score: app.score, positions: app.positions, events: app.events, target: app.scoreTempo };
    const brief = lessonBrief(lesson, music);
    const key = JSON.stringify([app.state?.score?.id, lesson.from, lesson.to, brief.hands, brief.tempo]);
    if (planned?.key !== key) {
      const mine = { key, ready: null };
      const written = app
        .compose(writerRequest(brief))
        .then((script) => planFromScript(script, brief))
        .catch((error) => {
          console.warn("MusicHands: the lesson could not be written.", error);
          return null;
        });
      mine.plan = Promise.race([written, new Promise((resolve) => setTimeout(() => resolve(null), WRITER_WAIT))]).then((plan) => (mine.ready = plan ?? readyMadePlan(lesson, music)));
      planned = mine;
    }
    return planned;
  }

  // The step the lesson is at, if its plan is there yet.
  function stepNow(lesson = current()) {
    return (lesson && planning(lesson).ready?.steps[lesson.step]) || null;
  }

  // -------------------------------------------------------------------------
  // Choosing the measures in the notation. The measure on screen and the few
  // after it are offered; a click on a measure starts the passage there, and
  // a second click ends it (in either direction).

  function offerLesson() {
    if (!app.score || !app.state) return;
    const offered = defaultLesson(app.measureIndex, app.score.measures.length);
    if (app.state.playing) app.change({ playing: false });
    showPicking({ from: offered.from, to: offered.to, anchor: null });
  }

  function showPicking(next) {
    const was = picking;
    picking = next;
    root.body.classList.toggle("picking-lesson", Boolean(picking));
    pick.root.hidden = !picking;
    if (!current()) learnButton.setAttribute("aria-pressed", String(Boolean(picking)));
    if (picking) {
      const number = (index) => app.score.measures[index].number;
      const chosen = picking.from === picking.to ? `Measure ${number(picking.from)}` : `Measures ${number(picking.from)}–${number(picking.to)}`;
      pick.text.textContent = picking.anchor === null ? `${chosen}. Click a measure to start somewhere else.` : `${chosen}. Now click the last measure.`;
    }
    if (Boolean(was) !== Boolean(picking)) app.onMeasure(picking ? { click: pickMeasure, hover: stretchTo } : null);
    if (!was || !picking || was.from !== picking.from || was.to !== picking.to) app.tint(picking ? { from: picking.from, to: picking.to, strong: true } : null);
  }

  function pickMeasure(index) {
    const { anchor } = picking;
    if (anchor === null) showPicking({ from: index, to: index, anchor: index });
    else showPicking({ from: Math.min(anchor, index), to: Math.max(anchor, index), anchor: null });
    return true;
  }

  // With one end chosen, the passage stretches to the measure under the pointer.
  function stretchTo(index) {
    if (picking?.anchor === null || picking?.anchor === undefined) return;
    showPicking({ from: Math.min(picking.anchor, index), to: Math.max(picking.anchor, index), anchor: picking.anchor });
  }

  function startPicked() {
    const { from, to } = picking;
    showPicking(null);
    startLesson(from, to);
  }

  // -------------------------------------------------------------------------
  // The lesson

  // Puts the workspace at the start of the passage, seen from above. Each
  // step is set up, talked through and then played by enterStep(), as the
  // change comes back through show().
  function startLesson(from, to) {
    if (!app.score || !app.state) return;
    const lesson = { from: Math.min(from, to), to: Math.max(from, to), step: 0, score: app.state.score?.id ?? "" };
    const passage = { from: lesson.from, to: lesson.to, times: 1 };
    app.change({ lesson, passage, time: lessonRange(lesson, app.score.measures).start, playing: false, pose: NO_POSE, hands: stageHands("both"), camera: { ...app.state.camera, view: { ...OVERHEAD }, autoCut: false } });
  }

  // The workspace as it is with no lesson on: the whole piece, both hands, at its own tempo.
  const NO_LESSON = { lesson: null, passage: null, playing: false, tempo: null, hands: stageHands("both"), pose: NO_POSE };

  function stopLesson() {
    if (!app.state?.lesson) return;
    turn += 1;
    voice.stop();
    app.change(NO_LESSON);
  }

  // "Got it": in a climb, a little faster; otherwise the next step, or done.
  function gotIt() {
    const lesson = current();
    const plan = lesson && planning(lesson).ready;
    if (!plan) return; // still being written
    const target = app.scoreTempo;
    const next = advanceLesson(lesson, plan, app.tempo, target);
    if (next.event === "step") {
      app.change({ lesson: next.lesson, playing: false }); // set up and talked through by enterStep()
      return;
    }
    if (next.event === "done") {
      turn += 1;
      app.change(NO_LESSON);
      sayAfresh(plan.closing || describeAdvance("done", { target }));
      return;
    }
    app.change({ tempo: next.tempo }); // the music, if playing, follows the new tempo where it is
    sayAfresh(describeAdvance(next.event, { tempo: next.tempo, target }));
  }

  // Says a step's lines, then plays the passage if the step plays it. A line
  // may come with something for the hands to do as it is said: a pose to
  // take, or a moment of the piece to play.
  function narrate(lesson, step, still, { thenPlay = true } = {}) {
    const lines = step.lines.map((line) => {
      if (line?.pose) return { say: line.say, before: () => still() && app.change({ pose: line.pose }) };
      if (line?.time !== undefined) return { say: line.say, before: () => still() && app.playMoment(line.time) };
      return line;
    });
    sayAfresh(lines).then((ending) => {
      if (!thenPlay || !step.times || ending === "dropped" || !still() || app.state.playing) return;
      app.playFrom(lessonRange(lesson, app.score.measures).start);
    });
  }

  // A step begins: once the plan is there, the workspace is set for the step
  // (its hands, its tempo, how often Play plays the passage) and the step is
  // talked through.
  async function enterStep(lesson) {
    const key = keyOf(lesson);
    const mine = ++turn;
    const still = () => mine === turn && keyOf(current()) === key;
    voice.stop();
    panel.caption.textContent = "";
    const { plan } = planning(lesson);
    const steps = (await plan).steps;
    if (!still()) return;
    const step = steps[lesson.step];
    if (!step) {
      stopLesson(); // past the end of the plan, or a plan with nothing in it
      return;
    }
    app.change({ passage: lessonPassage(lesson, step), hands: stageHands(step.hands), tempo: step.tempo, time: lessonRange(lesson, app.score.measures).start, playing: false, pose: NO_POSE });
    narrate(lesson, step, still);
  }

  // The passage from the top; played, in a step that plays it.
  function restart() {
    const lesson = current();
    if (!lesson) return;
    const { start } = lessonRange(lesson, app.score.measures);
    if (stepNow(lesson)?.times) app.playFrom(start);
    else app.change({ time: start, playing: false });
  }

  // The panel: where the lesson is, and what "got it" will do.
  function paint(state = app.state) {
    const lesson = current(state);
    panel.root.hidden = !lesson;
    if (lesson || !picking) learnButton.setAttribute("aria-pressed", String(Boolean(lesson)));
    learnButton.textContent = lesson ? "Learning…" : "Learn";
    if (!lesson) return;
    const range = lessonRange(lesson, app.score.measures);
    const step = stepNow(lesson);
    const tempos = { tempo: app.tempo, target: app.scoreTempo };
    panel.kicker.textContent = range.from === range.to ? `Learning measure ${range.from}` : `Learning measures ${range.from}–${range.to}`;
    panel.progress.textContent = step ? describeProgress(step, tempos) : "Writing your lesson…";
    panel.next.textContent = step ? describeNext(step, tempos) : "…";
    panel.next.disabled = !step;
    panel.play.textContent = state.playing ? "⏸ Pause" : "▶ Play";
    panel.play.title = state.playing ? "Pause the passage" : step?.times === Infinity ? "Play the passage on a loop" : "Play the passage";
  }

  // Lays the workspace's lesson on the screen. When a step begins, the
  // browser that began it (or the one that plays the music, when an agent
  // did) sets it up and talks it through.
  function show({ state, local, own, lead }) {
    // A lesson is begun by someone, never by opening the page: one left in
    // the workspace from before is ended, quietly, and the piece put back.
    if (opening) {
      opening = false;
      if (state.lesson) {
        seen = null;
        scoreSeen = state.score?.id ?? null;
        app.change(NO_LESSON);
        return;
      }
    }
    // Another piece has been opened: choosing stops, and a lesson on the old piece is over.
    const scoreId = state.score?.id ?? null;
    if (scoreId !== scoreSeen) {
      scoreSeen = scoreId;
      if (picking) showPicking(null);
    }
    const kept = cleanLesson(state.lesson);
    if (kept?.score && kept.score !== scoreId) app.change({ lesson: null });

    const lesson = current(state);
    paint(state);
    // The plan may still be on its way: the panel is filled in when it lands.
    if (lesson && !stepNow(lesson)) planning(lesson).plan.then(() => paint());
    const key = keyOf(lesson);
    if (key === seen) return;
    const wasOn = Boolean(seen);
    seen = key;
    if (!lesson) {
      turn += 1; // whatever was about to be said is not said
      if (wasOn && !own) voice.stop(); // ended elsewhere; the last word of a lesson finished here is left to play out
      panel.caption.textContent = "";
      return;
    }
    if (local || (lead && !own)) enterStep(lesson);
  }

  app.addEventListener("state", (event) => show(event.detail));
  // What was playing has played out: a step that moves on by itself does;
  // another says what to do next.
  app.addEventListener("played", () => {
    const step = stepNow();
    if (!step) return;
    if (step.auto) gotIt();
    else if (step.after) voice.say(step.after);
  });
  app.addEventListener("reset", () => {
    turn += 1;
    voice.stop();
    seen = undefined;
    scoreSeen = null;
    opening = true;
    if (picking) showPicking(null);
  });

  // L starts choosing (or stops it), G is "got it"; while choosing, Enter
  // takes the measures and Escape drops them, whatever has focus.
  app.onKey((event, { onControl }) => {
    if (picking && (event.key === "Enter" || event.key === "Escape")) {
      if (event.key === "Enter") startPicked();
      else showPicking(null);
      return true;
    }
    if (onControl) return false;
    if (event.key === "l" || event.key === "L") {
      if (picking) showPicking(null);
      else if (!current()) offerLesson();
      return true;
    }
    if ((event.key === "g" || event.key === "G") && current()) {
      gotIt();
      return true;
    }
    return false;
  });

  learnButton.addEventListener("click", () => (current() ? stopLesson() : picking ? showPicking(null) : offerLesson()));
  pick.start.addEventListener("click", startPicked);
  pick.cancel.addEventListener("click", () => showPicking(null));
  panel.next.addEventListener("click", gotIt);
  panel.stop.addEventListener("click", stopLesson);
  panel.play.addEventListener("click", () => app.togglePlaying());
  panel.restart.addEventListener("click", restart);
  panel.again.addEventListener("click", () => {
    const lesson = current();
    const step = stepNow(lesson);
    if (!step) return;
    const key = keyOf(lesson);
    const mine = ++turn;
    app.change({ pose: NO_POSE }); // a hand being placed is placed afresh
    narrate(lesson, step, () => mine === turn && keyOf(current()) === key, { thenPlay: !app.state.playing });
  });

  return { offerLesson, startLesson, stopLesson, gotIt };
}
