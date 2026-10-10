// The companion's box: the agent as it is with no lesson on. A line can be
// typed or spoken to it and it answers — with words, or by doing what was
// asked on the screen: going somewhere, playing something, a hand, a tempo,
// a fingering, the camera — without teaching. The first word brings it, on
// the server (teacher.js), where the learner is; it stays, through lessons
// and after them, until the piece changes. The box is small: the last few
// things said, and a line to say something. The page's link to the agent
// (host.link, agent-link.js) joins the session, performs its acts on the
// lead browser, and holds the voice and the microphone.
import { shownText } from "./lesson.js";

const LINES_SHOWN = 4;

const STATUS = {
  thinking: "Thinking…",
  speaking: "",
  playing: "Playing. Say something to stop it.",
  waiting: "",
  listening: "",
  failed: "",
  ended: "",
};

export function mountCompanion(app, host) {
  const { root } = host;
  const panel = {
    root: root.querySelector("#companion"),
    transcript: root.querySelector("#companion-transcript"),
    status: root.querySelector("#companion-status"),
    form: root.querySelector("#companion-say"),
    input: root.querySelector("#companion-input"),
    mic: root.querySelector("#companion-mic"),
  };

  let shown = false; // the box is on the screen: the site has an agent, a piece is open, and no lesson is on

  const { link } = host;
  link.watch(() => paint());

  // Is the agent already here (another browser spoke to it, say; or a lesson just ended)? Then join it.
  async function lookIn() {
    if (link.joined) return;
    try {
      const found = await app.teacher.status();
      if (shown && found.on) link.join();
    } catch {
      // Nothing to join.
    }
  }

  // What the learner says: the first word brings the agent, and the rest are heard by it.
  async function sendWords(text) {
    if (!shown) return;
    try {
      await link.sendWords(text);
    } catch (error) {
      link.setNote(`The agent did not hear that: ${error.message}`);
      return;
    }
    if (!link.joined) link.join();
  }

  function paint() {
    panel.root.hidden = !shown;
    if (!shown) return;
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
    const status = link.joined ? link.status ?? "thinking" : "";
    let said = link.note || STATUS[status] || "";
    if (status === "failed") said = `The agent could not be reached${link.error ? `: ${link.error}` : ""}. Say something to try again.`;
    if (link.paused) said = "Paused.";
    if (link.listening) said = "Listening…";
    panel.status.textContent = said;
    panel.mic.hidden = !link.micAvailable();
    panel.mic.setAttribute("aria-pressed", String(link.listening));
  }

  function show({ state, lesson }) {
    const was = shown;
    shown = Boolean(app.site.teacher && app.score && state && !lesson);
    if (shown && !was) lookIn();
    paint();
  }

  // V held is the microphone.
  function key(event, { onControl }) {
    if (onControl || !shown) return false;
    if ((event.key === "v" || event.key === "V") && link.micAvailable()) {
      if (!event.repeat) link.holdMic(true, sendWords);
      return true;
    }
    return false;
  }
  root.addEventListener("keyup", (event) => {
    if ((event.key === "v" || event.key === "V") && link.listening) link.holdMic(false, sendWords);
  });
  link.micButton(panel.mic, sendWords);
  panel.form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendWords(panel.input.value);
    panel.input.value = "";
  });

  return {
    show,
    key,
    leave: () => {
      shown = false;
      paint();
    },
    sendWords,
  };
}
