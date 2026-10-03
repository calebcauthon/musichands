// Learning mode, as a module on the sheet page. It is handed the page's `app`
// interface (the seam at the foot of sheet.js) and uses nothing else of the
// page: it reads the music and the workspace through it, and does everything
// it does by changing the workspace's public fields — tempo, hands, time,
// pose, passage, playing — as an agent could.
//
// The lesson itself is given by the teacher (teacher.js, on the server): an
// agent that knows the music and talks with the learner. This file is the
// Learn button, choosing the measures and the way of teaching, the lesson
// panel with what has been said, and the learner's ways of answering — the
// Got it button, a line typed, the microphone. On the browser that leads
// (the one that plays the music) it also performs what the teacher asks of
// the screen: saying a line, placing a hand, playing a moment or the
// passage, a pause. Each is reported done, which is when the teacher hears
// the result. Whatever the learner says while something is going on cuts it
// short, here and on the server alike.
//
// The lesson under way is kept in the workspace as `lesson` (lesson.js). The
// workspace stores it as given and never reads it.
import { cleanLesson, defaultLesson, lessonRange, shownText, stageHands } from "./lesson.js";
import { Microphone, Narrator } from "./speech.js";
import { findStyle, STYLES } from "./teaching-styles.js";

const NO_POSE = { left: null, right: null };
const MOMENT_PAUSE = 800; // ms a moment is left to sound before the next thing
const LINES_SHOWN = 8; // lines of the transcript kept on the panel
const GOT_IT = "Got it.";
const BACK_SECONDS = 5; // how far the back button goes

export function mountLearning(app, root = document) {
  const learnButton = root.querySelector("#learn");
  const panel = {
    root: root.querySelector("#lesson"),
    kicker: root.querySelector("#lesson-kicker"),
    progress: root.querySelector("#lesson-progress"),
    transcript: root.querySelector("#lesson-transcript"),
    status: root.querySelector("#lesson-status"),
    pause: root.querySelector("#lesson-pause"),
    back: root.querySelector("#lesson-back"),
    top: root.querySelector("#lesson-top"),
    form: root.querySelector("#lesson-say"),
    input: root.querySelector("#lesson-input"),
    mic: root.querySelector("#lesson-mic"),
    next: root.querySelector("#lesson-next"),
    stop: root.querySelector("#lesson-stop"),
  };
  const pick = {
    root: root.querySelector("#lesson-pick"),
    text: root.querySelector("#lesson-pick-text"),
    style: root.querySelector("#lesson-style"),
    said: root.querySelector("#lesson-said"),
    mic: root.querySelector("#lesson-pick-mic"),
    start: root.querySelector("#lesson-start"),
    cancel: root.querySelector("#lesson-cancel"),
  };
  for (const style of STYLES) {
    const option = root.createElement("option");
    option.value = style.id;
    option.textContent = style.name;
    option.title = style.blurb;
    pick.style.append(option);
  }

  let picking = null; // choosing the measures: { from, to, anchor }; anchor is the end clicked first, while the other is awaited
  let scoreSeen = null; // the piece that was open when the screen was last laid
  let opening = true; // the workspace has only just been opened: nothing has been laid on the screen yet
  let lead = false; // this browser plays the music, so it performs what the teacher asks of the screen

  let joined = null; // the lesson joined: { key, leave, transcript, status, error }
  let act = null; // what the screen is doing for the teacher: { id, type, loop, cancel }

  const voice = new Narrator({ fetchSpeech: (text) => app.speech(text) });
  const microphone = new Microphone();

  // The lesson the workspace holds, if it is one on the piece that is open.
  function current(state = app.state) {
    const lesson = cleanLesson(state?.lesson);
    return lesson && app.score && (!lesson.score || lesson.score === state.score?.id) ? lesson : null;
  }

  // -------------------------------------------------------------------------
  // Choosing the measures in the notation. The measure on screen and the few
  // after it are offered; a click on a measure starts the passage there, and
  // a second click ends it (in either direction).

  function offerLesson() {
    if (!app.score || !app.state || !app.site.teacher) return;
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
      if (!was) pick.said.value = "";
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
    const style = pick.style.value;
    const said = pick.said.value.trim();
    showPicking(null);
    pick.start.disabled = true;
    try {
      // The teacher sets the workspace up for the lesson; the change comes back through show().
      await app.teacher.start({ from, to, style, said });
    } catch (error) {
      console.warn("MusicHands: the lesson could not start.", error);
      app.change({ lesson: null });
      showPicking({ from, to, anchor: null });
      pick.text.textContent = `The teacher could not start: ${error.message}`;
    } finally {
      pick.start.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // The lesson on the screen

  // The workspace as it is with no lesson on: the whole piece, both hands, at its own tempo.
  const NO_LESSON = { lesson: null, passage: null, playing: false, tempo: null, hands: stageHands("both"), pose: NO_POSE };

  // Joins the lesson the workspace holds: what has been said so far, and
  // from now on what the teacher says and asks for.
  async function join(lesson) {
    const key = JSON.stringify(lesson);
    if (joined?.key === key) return;
    leave();
    const mine = { key, transcript: [], status: null, error: "", leave: null };
    joined = mine;
    mine.leave = app.teacher.events((event, data) => {
      if (joined !== mine) return;
      if (event === "said") mine.transcript[data.n] = data;
      else if (event === "status") {
        mine.status = data.status;
        mine.error = data.error ?? "";
      } else if (event === "act") perform(data);
      else if (event === "cut") cutShort(data.id);
      else if (event === "ended") {
        mine.status = data.reason === "failed" ? "failed" : "ended";
        mine.error = data.error ?? "";
        if (data.reason === "failed") app.change(NO_LESSON);
      }
      paint();
    });
    try {
      const status = await app.teacher.status();
      if (joined !== mine) return;
      if (!status.on) {
        // The server knows of no lesson (it was restarted, say): the workspace's is over.
        app.change(NO_LESSON);
        return;
      }
      for (const line of status.transcript) mine.transcript[line.n] ??= line;
      mine.status ??= status.status;
      for (const waiting of status.acts ?? []) perform(waiting);
    } catch (error) {
      if (joined === mine) {
        console.warn("MusicHands: the lesson could not be joined.", error);
        if (error.status === 503) app.change(NO_LESSON);
      }
    }
    paint();
  }

  function leave() {
    if (!joined) return;
    joined.leave?.();
    joined = null;
    cutShort(act?.id, { tell: false });
    paused = false;
    voice.stop();
  }

  function stopLesson() {
    if (!app.state?.lesson) return;
    cutShort(act?.id, { tell: false });
    voice.stop();
    app.teacher.stop().catch(() => {}); // the teacher puts the workspace back; if it cannot be reached, the page does
    app.change(NO_LESSON);
  }

  // -------------------------------------------------------------------------
  // What the teacher asks of the screen

  // Performs an act, when this is the browser that plays the music, and
  // reports it done. A `cancel` undoes what can be undone when it is cut short.
  let held = null; // an act that arrived while the lesson was paused, kept for when it goes on
  function perform(asked) {
    if (!lead || !joined || act?.id === asked.id) return;
    if (paused) {
      held = asked;
      return;
    }
    if (act) cutShort(act.id, { tell: false }); // only one thing at a time; a newer act takes over
    const mine = { id: asked.id, type: asked.type, loop: Boolean(asked.loop), cancel: null };
    act = mine;
    const still = () => act === mine;
    const finish = (result) => {
      if (!still()) return;
      act = null;
      app.teacher.done(mine.id, result).catch(() => {});
      paint();
    };
    const after = (ms, result) => {
      const timer = setTimeout(() => finish(result), ms);
      mine.cancel = () => clearTimeout(timer);
    };
    switch (asked.type) {
      case "say":
        voice.stop();
        voice.say(asked.text).then((ending) => ending !== "dropped" && finish({ spoken: ending === "spoken" }));
        mine.cancel = () => voice.stop();
        break;
      case "pause":
        after(asked.ms, { paused: true });
        break;
      case "place": {
        const { hand, fingers, press } = asked;
        if (app.state.playing) app.change({ playing: false });
        app.change({ pose: { [hand]: fingers.length ? { fingers, press } : null } });
        after(asked.pauseMs ?? 0, { placed: true });
        break;
      }
      case "play_moment":
        if (app.state.playing) app.change({ playing: false });
        app.change({ hands: stageHands(asked.hands), pose: NO_POSE });
        app.playMoment(asked.time);
        after(MOMENT_PAUSE, { played: true });
        break;
      case "play": {
        const passage = { from: asked.from, to: asked.to, times: asked.loop ? null : asked.times, start: asked.start ?? null, end: asked.end ?? null };
        app.playFrom(lessonRange(passage, app.score.measures).start, { passage, hands: stageHands(asked.hands), tempo: asked.tempo, pose: NO_POSE });
        mine.cancel = () => app.state?.playing && app.change({ playing: false });
        // Finished by the "played" event below; a loop only by being cut short.
        break;
      }
      default:
        finish({ error: `the screen cannot ${asked.type}` });
    }
    paint();
  }

  // Cuts the act short here: the voice and the music stop. With `tell`, the
  // teacher is told it was interrupted (when the learner's words will not say so).
  function cutShort(id, { tell = false } = {}) {
    if (held && (id === undefined || held.id === id)) held = null;
    if (!act || (id !== undefined && act.id !== id)) return;
    const mine = act;
    act = null;
    mine.cancel?.();
    if (tell) app.teacher.done(mine.id, { interrupted: true, learner_said: "" }).catch(() => {});
    paint();
  }

  app.addEventListener("played", () => {
    if (act?.type !== "play" || act.loop) return;
    const mine = act;
    act = null;
    app.teacher.done(mine.id, { played: true }).catch(() => {});
    paint();
  });

  // -------------------------------------------------------------------------
  // The learner's hand on the music: pause where it is, back a little, from the top

  let paused = false; // the lesson is held: the voice where it was, the music where it was
  let musicHeld = false; // the music was playing when it was held

  function pauseOrResume() {
    if (!current()) return;
    if (paused) {
      paused = false;
      voice.resume();
      if (musicHeld && !app.state.playing) app.togglePlaying();
      if (held) {
        const next = held;
        held = null;
        perform(next);
      }
    } else {
      paused = true;
      musicHeld = Boolean(app.state.playing);
      voice.pause();
      if (musicHeld) app.change({ playing: false });
    }
    paint();
  }

  // Plays the music from a little before where it is, or from the top of
  // the passage; always plays, so there is nothing else to press.
  function playBack(seconds) {
    const lesson = current();
    if (!lesson) return;
    const { start } = lessonRange(app.state.passage ?? lesson, app.score.measures);
    const time = seconds === null ? start : Math.max(start, (app.state.time ?? start) - (seconds * app.tempo) / 60);
    if (paused) pauseOrResume();
    app.playFrom(time);
    paint();
  }

  // -------------------------------------------------------------------------
  // What the learner says

  // Sends the learner's words to the teacher, cutting short whatever the
  // screen was doing: the teacher hears them in its place.
  function sendWords(text) {
    const words = String(text ?? "").trim();
    if (!words || !current()) return;
    if (act) {
      const mine = act;
      act = null;
      mine.cancel?.();
    }
    held = null;
    paused = false;
    voice.stop();
    if (joined) joined.transcript.push({ who: "learner", text: words }); // shown at once; the server's numbered copy takes its place
    paint();
    app.teacher.say(words).catch((error) => console.warn("MusicHands: the teacher did not hear that.", error));
  }

  // The microphone, held: while it is down the voice and the music are
  // stopped so they are not heard as speech; what was said is sent when it
  // is let go (or put in the picker's box, while choosing).
  let listening = false;
  let interrupted = null; // the act the microphone cut short, until its words are sent or it is given up
  async function holdMic(down) {
    if (down === listening) return;
    listening = down;
    root.body.classList.toggle("mic-down", down);
    paint();
    if (down) {
      if (current() && act) {
        interrupted = act;
        act.cancel?.();
      }
      paused = false;
      voice.stop();
      try {
        await microphone.start();
      } catch (error) {
        listening = false;
        root.body.classList.remove("mic-down");
        giveUp(`The microphone could not be used: ${error.message}`);
      }
      return;
    }
    const audio = await microphone.stop();
    if (!audio) return giveUp("Nothing was heard.");
    setNote("Hearing…");
    try {
      const text = await app.hear(audio);
      setNote("");
      if (text === null) return giveUp("This site has no ears: type instead.");
      if (!text) return giveUp("Nothing was heard.");
      interrupted = null;
      if (picking) pick.said.value = text;
      else sendWords(text);
    } catch (error) {
      giveUp(`That could not be made out: ${error.message}`);
    }
  }
  // Nothing came of the microphone: the act it cut short is reported so, with no words.
  function giveUp(why) {
    if (interrupted) cutShort(interrupted.id, { tell: true });
    interrupted = null;
    setNote(why);
  }
  let note = ""; // a word from the page itself on the status line
  function setNote(text) {
    note = text;
    paint();
  }

  // -------------------------------------------------------------------------
  // The panel

  const STATUS = {
    thinking: "The teacher is thinking…",
    speaking: "",
    playing: "Playing. Say something or press Got it to stop it.",
    waiting: "",
    listening: "Your turn: press Got it, or say something.",
    failed: "",
    done: "",
    ended: "",
  };

  function paint(state = app.state) {
    const lesson = current(state);
    panel.root.hidden = !lesson;
    learnButton.hidden = !app.site.teacher;
    if (lesson || !picking) learnButton.setAttribute("aria-pressed", String(Boolean(lesson)));
    learnButton.textContent = lesson ? "Learning…" : "Learn";
    pick.mic.hidden = !Microphone.supported || !app.site.ears;
    if (!lesson) return;
    const range = lessonRange(lesson, app.score.measures);
    panel.kicker.textContent = range.from === range.to ? `Learning measure ${range.from}` : `Learning measures ${range.from}–${range.to}`;
    panel.progress.textContent = findStyle(lesson.style).name;
    const lines = (joined?.transcript ?? []).filter(Boolean).slice(-LINES_SHOWN);
    panel.transcript.replaceChildren(
      ...lines.map((line) => {
        const p = root.createElement("p");
        p.className = `lesson__line lesson__line--${line.who === "learner" ? "learner" : "teacher"}`;
        p.textContent = line.who === "learner" ? line.text : shownText(line.text);
        return p;
      }),
    );
    panel.transcript.scrollTop = panel.transcript.scrollHeight;
    const status = joined?.status ?? "thinking";
    let said = note || STATUS[status] || "";
    if (status === "failed") said = `The teacher could not be reached${joined?.error ? `: ${joined.error}` : ""}. Press Got it to try again.`;
    if (paused) said = "Paused. Press Play to carry on.";
    if (listening) said = "Listening…";
    panel.status.textContent = said;
    panel.pause.textContent = paused ? "▶ Play" : "⏸ Pause";
    panel.pause.setAttribute("aria-pressed", String(paused));
    panel.mic.hidden = !Microphone.supported || !app.site.ears;
    panel.mic.setAttribute("aria-pressed", String(listening));
    pick.mic.setAttribute("aria-pressed", String(listening));
  }

  // Lays the workspace's lesson on the screen.
  function show({ state, lead: leads }) {
    lead = Boolean(leads);
    // A lesson is begun by someone, never by opening the page: one left in
    // the workspace from before is ended, quietly, and the piece put back.
    if (opening) {
      opening = false;
      if (state.lesson) {
        scoreSeen = state.score?.id ?? null;
        app.teacher.stop().catch(() => {});
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
    if (lesson) join(lesson);
    else leave();
    paint(state);
  }

  app.addEventListener("state", (event) => show(event.detail));
  app.addEventListener("reset", () => {
    leave();
    scoreSeen = null;
    opening = true;
    lead = false;
    if (picking) showPicking(null);
  });

  // L starts choosing (or stops it), G is "got it", V held is the
  // microphone; while choosing, Enter takes the measures and Escape drops
  // them, whatever has focus.
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
      sendWords(GOT_IT);
      return true;
    }
    if ((event.key === "v" || event.key === "V") && (current() || picking) && !panel.mic.hidden) {
      if (!event.repeat) holdMic(true);
      return true;
    }
    return false;
  });
  root.addEventListener("keyup", (event) => {
    if ((event.key === "v" || event.key === "V") && listening) holdMic(false);
  });
  for (const button of [panel.mic, pick.mic]) {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      holdMic(true);
    });
    for (const name of ["pointerup", "pointercancel"]) button.addEventListener(name, () => holdMic(false));
  }

  learnButton.addEventListener("click", () => (current() ? stopLesson() : picking ? showPicking(null) : offerLesson()));
  pick.start.addEventListener("click", startPicked);
  pick.cancel.addEventListener("click", () => showPicking(null));
  pick.said.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      startPicked();
    } else if (event.key === "Escape") showPicking(null);
  });
  panel.form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendWords(panel.input.value);
    panel.input.value = "";
  });
  panel.next.addEventListener("click", () => sendWords(GOT_IT));
  panel.stop.addEventListener("click", stopLesson);
  panel.pause.addEventListener("click", pauseOrResume);
  panel.back.addEventListener("click", () => playBack(BACK_SECONDS));
  panel.top.addEventListener("click", () => playBack(null));

  return { offerLesson, stopLesson, sendWords };
}
