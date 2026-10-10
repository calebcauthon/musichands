// A lesson with the teacher: the way of learning (see learning.js for the
// shape) in which the teacher (teacher.js, on the server) — an agent that
// knows the music and talks with the learner — gives the lesson. This file is
// its choices in the picker (a teaching style, something to tell the
// teacher), its panel with what has been said, and the learner's ways of
// answering — the Got it button, a line typed, the microphone. The teacher
// is the one agent of the workspace, told how to teach for the while; the
// page's link to it (host.link, agent-link.js) joins the session, performs
// what the teacher asks of the screen, and holds the voice and the microphone.
import { backTime, cleanLesson, lessonRange, NO_LESSON, shownText } from "./lesson.js";
import { findStyle, STYLES } from "./teaching-styles.js";

const LINES_SHOWN = 8; // lines of the transcript kept on the panel
const GOT_IT = "Got it.";
const BACK_SECONDS = 5; // how far the back button goes

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

function mount(app, host) {
  const { root } = host;
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
  const pick = { style: root.querySelector("#lesson-style"), said: root.querySelector("#lesson-said"), mic: root.querySelector("#lesson-pick-mic") };
  for (const style of STYLES) {
    const option = root.createElement("option");
    option.value = style.id;
    option.textContent = style.name;
    option.title = style.blurb;
    pick.style.append(option);
  }

  const { link } = host;
  link.watch((event, data) => {
    // The server knows of no agent (it was restarted, say), or it failed: the workspace's lesson is over.
    if (current() && (event === "absent" || (event === "ended" && data.reason === "failed") || (event === "unreachable" && data?.status === 503))) app.change(NO_LESSON);
    paint();
  });

  // The lesson the workspace holds, if it is this module's, on the piece that is open.
  function current(state = app.state) {
    const lesson = cleanLesson(state?.lesson);
    return lesson?.mode === "teacher" && app.score && (!lesson.score || lesson.score === state.score?.id) ? lesson : null;
  }

  // -------------------------------------------------------------------------
  // Starting, joining and leaving

  async function start({ from, to }) {
    const style = pick.style.value;
    const said = pick.said.value.trim();
    pick.said.value = "";
    // The teacher sets the workspace up for the lesson; the change comes back through show().
    await app.teacher.start({ from, to, style, said });
  }

  function stop() {
    if (!current()) return;
    link.cutShort(undefined, { tell: false });
    link.stopVoice();
    app.teacher.stop().catch(() => {}); // the teacher puts the workspace back; if it cannot be reached, the page does
    app.change(NO_LESSON);
  }

  // Plays the music from a little before where it is, or from the top of
  // the passage; always plays, so there is nothing else to press.
  function playBack(seconds) {
    const lesson = current();
    if (!lesson) return;
    const { start: top } = lessonRange(app.state.passage ?? lesson, app.score.measures);
    const time = seconds === null ? top : backTime(app.state.time, seconds, app.tempo, top);
    if (link.paused) link.pauseOrResume();
    app.playFrom(time);
    paint();
  }

  // What the learner says goes to the teacher, when there is a lesson to say it in.
  function sendWords(text) {
    if (!current()) return;
    link.sendWords(text).catch((error) => console.warn("MusicHands: the teacher did not hear that.", error));
  }
  // Words from the microphone go in the picker's box while choosing, else to the teacher.
  const heard = (text) => (host.picking() ? (pick.said.value = text) : sendWords(text));

  // -------------------------------------------------------------------------
  // The panel

  function paint(state = app.state) {
    const lesson = current(state);
    panel.root.hidden = !lesson;
    pick.mic.hidden = !link.micAvailable();
    pick.mic.setAttribute("aria-pressed", String(link.listening));
    if (!lesson) return;
    const range = lessonRange(lesson, app.score.measures);
    panel.kicker.textContent = range.from === range.to ? `Learning measure ${range.from}` : `Learning measures ${range.from}–${range.to}`;
    panel.progress.textContent = findStyle(lesson.style).name;
    const lines = link.lines().slice(-LINES_SHOWN);
    panel.transcript.replaceChildren(
      ...lines.map((line) => {
        const p = root.createElement("p");
        p.className = `lesson__line lesson__line--${line.who === "learner" ? "learner" : "teacher"}`;
        p.textContent = line.who === "learner" ? line.text : shownText(line.text);
        return p;
      }),
    );
    panel.transcript.scrollTop = panel.transcript.scrollHeight;
    const status = link.status ?? "thinking";
    let said = link.note || STATUS[status] || "";
    if (status === "failed") said = `The teacher could not be reached${link.error ? `: ${link.error}` : ""}. Press Got it to try again.`;
    if (link.paused) said = "Paused. Press Play to carry on.";
    if (link.listening) said = "Listening…";
    panel.status.textContent = said;
    panel.pause.textContent = link.paused ? "▶ Play" : "⏸ Pause";
    panel.pause.setAttribute("aria-pressed", String(link.paused));
    panel.mic.hidden = !link.micAvailable();
    panel.mic.setAttribute("aria-pressed", String(link.listening));
  }

  function show({ state }) {
    link.join();
    paint(state);
  }

  // G is "got it", V held is the microphone.
  function key(event, { onControl, picking }) {
    if (onControl) return false;
    if ((event.key === "g" || event.key === "G") && current()) {
      sendWords(GOT_IT);
      return true;
    }
    if ((event.key === "v" || event.key === "V") && (current() || picking) && link.micAvailable()) {
      if (!event.repeat) link.holdMic(true, heard);
      return true;
    }
    return false;
  }
  root.addEventListener("keyup", (event) => {
    if ((event.key === "v" || event.key === "V") && link.listening) link.holdMic(false, heard);
  });
  for (const button of [panel.mic, pick.mic]) link.micButton(button, heard);
  panel.form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendWords(panel.input.value);
    panel.input.value = "";
  });
  panel.next.addEventListener("click", () => sendWords(GOT_IT));
  panel.stop.addEventListener("click", stop);
  panel.pause.addEventListener("click", () => {
    link.pauseOrResume();
    paint();
  });
  panel.back.addEventListener("click", () => playBack(BACK_SECONDS));
  panel.top.addEventListener("click", () => playBack(null));

  return {
    start,
    show,
    leave: () => paint(), // the lesson is off the screen; the agent and the link stay
    stop,
    key,
    discard: () => app.teacher.stop().catch(() => {}),
    sendWords,
  };
}

export default {
  id: "teacher",
  name: "With a teacher",
  blurb: "A teacher who knows the music talks you through it, and listens.",
  available: (app) => Boolean(app.site.teacher),
  mount,
};
