// Learning mode, as a module on the sheet page. It is handed the page's `app`
// interface (the seam at the foot of sheet.js) and uses nothing else of the
// page: it reads the music and the workspace through it, and does everything
// it does by changing the workspace's public fields — tempo, hands, time,
// pose, passage, playing — as an agent could.
//
// There are several ways of learning, each a module of its own with the same
// shape (see MODES): a lesson with a teacher who talks and listens
// (learning-teacher.js), and the drill, rigid and silent (learning-drill.js).
// This file is what they share: the Learn button, choosing the measures in
// the notation and the way of learning them, and handing the lesson under
// way to the module it belongs to. The lesson is kept in the workspace as
// `lesson` (lesson.js), with `mode` saying whose it is; the workspace stores
// it as given and never reads it.
//
// A way of learning is { id, name, blurb, available(app), mount(app, host) },
// and what mount answers has:
//   start({ from, to })        begins a lesson on those measures: the module writes `lesson` to the workspace
//   show({ state, lesson, lead })  the workspace's lesson, of this module's mode, laid on the screen
//   leave()                    the lesson is no longer on the screen: ended, or another piece opened
//   discard()                  a lesson of this mode found when the page opened: put right quietly
//   key(event, { onControl, picking }) → true if taken
// The host gives it { root, picking() } and the module's own markup is in index.html.
import { cleanLesson, defaultLesson, DEFAULT_MODE, NO_LESSON } from "./lesson.js";
import drillMode from "./learning-drill.js";
import teacherMode from "./learning-teacher.js";

export const MODES = [teacherMode, drillMode];

export function mountLearning(app, root = document) {
  const learnButton = root.querySelector("#learn");
  const pick = {
    root: root.querySelector("#lesson-pick"),
    text: root.querySelector("#lesson-pick-text"),
    modes: root.querySelector("#lesson-modes"),
    options: [...root.querySelectorAll(".lesson-pick__options")],
    start: root.querySelector("#lesson-start"),
    cancel: root.querySelector("#lesson-cancel"),
  };

  let picking = null; // choosing the measures: { from, to, anchor }; anchor is the end clicked first, while the other is awaited
  let chosen = DEFAULT_MODE; // the way of learning picked
  let scoreSeen = null; // the piece that was open when the screen was last laid
  let opening = true; // the workspace has only just been opened: nothing has been laid on the screen yet
  let shown = null; // the module whose lesson is on the screen

  const host = { root, picking: () => picking };
  const modules = new Map(MODES.map((mode) => [mode.id, { ...mode, ...mode.mount(app, host) }]));
  const modeOf = (lesson) => (lesson && modules.get(lesson.mode)) || null;
  const offered = () => MODES.filter((mode) => mode.available(app));

  // The lesson the workspace holds, if it is one on the piece that is open and of a way of learning there is.
  function current(state = app.state) {
    const lesson = cleanLesson(state?.lesson);
    return lesson && app.score && modules.has(lesson.mode) && (!lesson.score || lesson.score === state.score?.id) ? lesson : null;
  }

  // -------------------------------------------------------------------------
  // Choosing the measures in the notation, and the way of learning them. The
  // measure on screen and the few after it are offered; a click on a measure
  // starts the passage there, and a second click ends it (in either direction).

  for (const mode of MODES) {
    const button = root.createElement("button");
    button.className = "button";
    button.type = "button";
    button.dataset.mode = mode.id;
    button.textContent = mode.name;
    button.title = mode.blurb;
    button.addEventListener("click", () => chooseMode(mode.id));
    pick.modes.append(button);
  }

  function chooseMode(id) {
    chosen = id;
    for (const button of pick.modes.children) button.setAttribute("aria-pressed", String(button.dataset.mode === chosen));
    for (const options of pick.options) options.hidden = options.dataset.mode !== chosen;
  }

  function offerLesson() {
    if (!app.score || !app.state) return;
    const ways = offered();
    if (!ways.length) return;
    if (!ways.some((mode) => mode.id === chosen)) chosen = ways[0].id;
    for (const button of pick.modes.children) button.hidden = !ways.some((mode) => mode.id === button.dataset.mode);
    chooseMode(chosen);
    const first = defaultLesson(app.measureIndex, app.score.measures.length);
    if (app.state.playing) app.change({ playing: false });
    showPicking({ from: first.from, to: first.to, anchor: null });
  }

  function showPicking(next) {
    const was = picking;
    picking = next;
    root.body.classList.toggle("picking-lesson", Boolean(picking));
    pick.root.hidden = !picking;
    if (!current()) learnButton.setAttribute("aria-pressed", String(Boolean(picking)));
    if (picking) {
      const number = (index) => app.score.measures[index].number;
      const measures = picking.from === picking.to ? `Measure ${number(picking.from)}` : `Measures ${number(picking.from)}–${number(picking.to)}`;
      pick.text.textContent = picking.anchor === null ? `${measures}. Click a measure to start somewhere else.` : `${measures}. Now click the last measure.`;
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

  async function startPicked() {
    const { from, to } = picking;
    const mode = modules.get(chosen);
    showPicking(null);
    pick.start.disabled = true;
    try {
      await mode.start({ from, to }); // the change comes back through show()
    } catch (error) {
      console.warn(`MusicHands: the lesson (${mode.id}) could not start.`, error);
      app.change({ lesson: null });
      showPicking({ from, to, anchor: null });
      pick.text.textContent = `It could not start: ${error.message}`;
    } finally {
      pick.start.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // The lesson on the screen, handed to the way of learning it belongs to

  function paint(state = app.state) {
    const lesson = current(state);
    learnButton.hidden = !offered().length;
    if (lesson || !picking) learnButton.setAttribute("aria-pressed", String(Boolean(lesson)));
    learnButton.textContent = lesson ? "Learning…" : "Learn";
  }

  function leave() {
    shown?.leave();
    shown = null;
  }

  function show({ state, lead }) {
    // A lesson is begun by someone, never by opening the page: one left in
    // the workspace from before is ended, quietly, and the piece put back.
    if (opening) {
      opening = false;
      if (state.lesson) {
        scoreSeen = state.score?.id ?? null;
        modeOf(cleanLesson(state.lesson))?.discard();
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
    const mode = modeOf(lesson);
    if (shown && shown !== mode) leave();
    shown = mode;
    if (mode) mode.show({ state, lesson, lead: Boolean(lead) });
    paint(state);
  }

  app.addEventListener("state", (event) => show(event.detail));
  app.addEventListener("reset", () => {
    leave();
    scoreSeen = null;
    opening = true;
    if (picking) showPicking(null);
  });

  // L starts choosing (or stops it); while choosing, Enter takes the
  // measures and Escape drops them, whatever has focus. The rest of the keys
  // are the way of learning's.
  app.onKey((event, { onControl }) => {
    if (picking && (event.key === "Enter" || event.key === "Escape")) {
      if (event.key === "Enter") startPicked();
      else showPicking(null);
      return true;
    }
    const mode = shown ?? (picking ? modules.get(chosen) : null);
    if (mode?.key(event, { onControl, picking: Boolean(picking) })) return true;
    if (onControl) return false;
    if (event.key === "l" || event.key === "L") {
      if (picking) showPicking(null);
      else if (!current()) offerLesson();
      return true;
    }
    return false;
  });

  learnButton.addEventListener("click", () => (current() ? shown?.stop() : picking ? showPicking(null) : offerLesson()));
  pick.start.addEventListener("click", startPicked);
  pick.cancel.addEventListener("click", () => showPicking(null));
  pick.root.addEventListener("keydown", (event) => {
    if (!event.target.matches("input")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      startPicked();
    } else if (event.key === "Escape") showPicking(null);
  });

  return { offerLesson, startPicked, stopLesson: () => shown?.stop(), modules };
}
