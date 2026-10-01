// Learning mode, as a module on the sheet page. It is handed the page's `app`
// interface (the seam at the foot of sheet.js) and uses nothing else of the
// page: it reads the music and the workspace through it, and does everything
// it does by changing the workspace's public fields — tempo, hands, time,
// camera, pose, passage, playing — as an agent could. What a lesson is, the
// order it goes in and every word the voice says are in lesson.js; this file
// is the Learn button, choosing the measures, the lesson panel and the voice.
//
// The lesson under way is kept in the workspace as `lesson`. The workspace
// stores it as given and never reads it, so the shape of a lesson can change
// here without touching the page or the server.
import { advanceLesson, cleanLesson, defaultLesson, describeAdvance, describeNext, describePlayed, describeProgress, introTempo, lessonHands, lessonPassage, lessonRange, OVERHEAD, phaseLines, phasePlays, stageHands } from "./lesson.js";
import { Narrator } from "./speech.js";

const NO_POSE = { left: null, right: null };
const keyOf = (lesson) => (lesson ? `${lesson.from}-${lesson.to}:${lesson.stage}:${lesson.phase}` : null);

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

  // The panel shows what has been said in the phase so far, a line at a time.
  const voice = new Narrator({
    fetchSpeech: (text) => app.speech(text),
    onLine: (line) => {
      panel.caption.textContent = panel.caption.textContent ? `${panel.caption.textContent} ${line}` : line;
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

  // The workspace as it should be where a lesson stands: its measures for
  // Play to keep to, the hands it is about, quiet at the top of the passage.
  function standing(lesson) {
    return { lesson, passage: lessonPassage(lesson), hands: lessonHands(lesson), time: lessonRange(lesson, app.score.measures).start, playing: false, pose: NO_POSE };
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

  // Puts the workspace at the start of the passage, seen from above, for the
  // whole of it to be heard. Each phase is talked through, and then played,
  // by show() as the change comes back.
  function startLesson(from, to) {
    if (!app.score || !app.state) return;
    const lesson = { from: Math.min(from, to), to: Math.max(from, to), stage: "right", phase: "intro", score: app.state.score?.id ?? "" };
    app.change({ ...standing(lesson), tempo: introTempo(app.scoreTempo), camera: { ...app.state.camera, view: { ...OVERHEAD }, autoCut: false } });
  }

  function stopLesson() {
    if (!app.state?.lesson) return;
    voice.stop();
    app.change({ lesson: null, passage: null, playing: false, tempo: null, hands: stageHands("both"), pose: NO_POSE });
  }

  // "Got it": the next phase, or a little faster, or the next hand, or done.
  function gotIt() {
    const lesson = current();
    if (!lesson) return;
    const target = app.scoreTempo;
    const next = advanceLesson(lesson, app.tempo, target);
    if (next.event === "done") app.change({ lesson: null, passage: null, tempo: target, hands: stageHands("both"), playing: false, pose: NO_POSE });
    else if (keyOf(next.lesson) !== keyOf(lesson)) {
      // A new phase: back to the top of the passage, quiet, the hands back to the score's, for the voice to introduce it (show()).
      app.change({ ...standing(next.lesson), tempo: next.tempo });
      return;
    } else app.change({ tempo: next.tempo }); // the music, if playing, follows the new tempo where it is
    sayAfresh(describeAdvance(next.event, { tempo: next.tempo, target }));
  }

  // Talks the phase through, then plays the passage if the phase plays it.
  // A line may come with something for the hands to do as it is said: a pose
  // to take, or a moment of the piece to play.
  function narratePhase(lesson, { thenPlay = true } = {}) {
    const key = keyOf(lesson);
    const still = () => keyOf(current()) === key;
    const lines = phaseLines(lesson, { score: app.score, positions: app.positions, events: app.events, tempo: app.tempo, target: app.scoreTempo }).map((line) => {
      if (line?.pose) return { say: line.say, before: () => still() && app.change({ pose: line.pose }) };
      if (line?.time !== undefined) return { say: line.say, before: () => still() && app.playMoment(line.time) };
      return line;
    });
    sayAfresh(lines).then((ending) => {
      if (!thenPlay || !phasePlays(lesson.phase) || ending === "dropped" || !still() || app.state.playing) return;
      app.playFrom(lessonRange(lesson, app.score.measures).start);
    });
  }

  // The passage from the top; played, in a phase that plays it.
  function restart() {
    const lesson = current();
    if (!lesson) return;
    const { start } = lessonRange(lesson, app.score.measures);
    if (phasePlays(lesson.phase)) app.playFrom(start);
    else app.change({ time: start, playing: false });
  }

  // Lays the workspace's lesson on the screen. When a phase begins, the
  // browser that began it (or the one that plays the music, when an agent
  // did) talks it through.
  function show({ state, local, own, lead }) {
    // Another piece has been opened: choosing stops, and a lesson on the old piece is over.
    const scoreId = state.score?.id ?? null;
    if (scoreId !== scoreSeen) {
      scoreSeen = scoreId;
      if (picking) showPicking(null);
    }
    const kept = cleanLesson(state.lesson);
    if (kept?.score && kept.score !== scoreId) app.change({ lesson: null });

    const lesson = current(state);
    const target = app.scoreTempo;
    panel.root.hidden = !lesson;
    if (lesson || !picking) learnButton.setAttribute("aria-pressed", String(Boolean(lesson)));
    learnButton.textContent = lesson ? "Learning…" : "Learn";
    if (lesson) {
      const range = lessonRange(lesson, app.score.measures);
      panel.kicker.textContent = range.from === range.to ? `Learning measure ${range.from}` : `Learning measures ${range.from}–${range.to}`;
      panel.progress.textContent = describeProgress(lesson, { tempo: app.tempo, target });
      panel.next.textContent = describeNext(lesson, { tempo: app.tempo, target });
      panel.play.textContent = state.playing ? "⏸ Pause" : "▶ Play";
      panel.play.title = state.playing ? "Pause the passage" : phasePlays(lesson.phase) === Infinity ? "Play the passage on a loop" : "Play the passage";
    }
    const key = keyOf(lesson);
    if (key === seen) return;
    const wasOn = Boolean(seen);
    seen = key;
    if (!lesson) {
      if (wasOn && !own) voice.stop(); // ended elsewhere; the "well done" of a finish here is left to play out
      panel.caption.textContent = "";
      return;
    }
    if (local || (lead && !own)) narratePhase(lesson);
  }

  app.addEventListener("state", (event) => show(event.detail));
  // What was playing has played out: the introduction goes straight on to
  // the first hand; other phases say what to do next.
  app.addEventListener("played", () => {
    const lesson = current();
    if (!lesson) return;
    if (lesson.phase === "intro") gotIt();
    else voice.say(describePlayed(lesson.phase));
  });
  app.addEventListener("reset", () => {
    voice.stop();
    seen = undefined;
    scoreSeen = null;
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
    if (!lesson) return;
    if (lesson.phase === "position") app.change({ pose: NO_POSE });
    narratePhase(lesson, { thenPlay: !app.state.playing });
  });

  return { offerLesson, startLesson, stopLesson, gotIt };
}
