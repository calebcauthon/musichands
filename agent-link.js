// The page's link to the agent on the server (teacher.js). There is one
// agent in a workspace, whether a lesson is on or not, and one link to it on
// the page, shared by the panels that show it (the lesson's, the
// companion's). The link joins the session (what has been said so far, and
// from now on what the agent says and asks for) and, on the browser that
// leads (the one that plays the music), performs what the agent asks of the
// screen: saying a line, placing a hand, playing a moment or some measures,
// a pause. Each is reported done, which is when the agent hears the result.
// It also carries the learner's words in — typed, a button, the microphone
// held — cutting short whatever the screen was doing, here and on the
// server alike, and it can hold the whole thing where it is (pause) and
// take it up again.
//
// The panels decide when words may be sent and what to show; the link tells
// each watcher of every change ("change"), of the server having no session
// ("absent"), of not being reachable ("unreachable"), and of the session's
// end ("ended").
import { lessonRange, stageHands } from "./lesson.js";
import { Microphone, Narrator } from "./speech.js";

const NO_POSE = { left: null, right: null };
const HANDS = ["left", "right"];
const MOMENT_PAUSE = 800; // ms a moment is left to sound before the next thing

export function createAgentLink(app, { root = document } = {}) {
  const watchers = new Set();
  const onEvent = (event, data) => {
    for (const handler of watchers) handler(event, data);
  };
  const onChange = () => onEvent("change", {});
  let lead = false; // this browser plays the music, so it performs what the agent asks of the screen
  let joined = null; // the session joined: { leave }
  let transcript = []; // what has been said, numbered by the server; a line of ours is shown before its number arrives
  let status = null; // what the agent is doing, as the server says: thinking, speaking, playing, waiting, listening, failed
  let error = "";
  let act = null; // what the screen is doing for the agent: { id, type, loop, cancel }
  let held = null; // an act that arrived while paused, kept for when it goes on
  let paused = false; // held where it is: the voice where it was, the music where it was
  let musicHeld = false; // the music was playing when it was held
  let listening = false; // the microphone is down
  let interrupted = null; // the act the microphone cut short, until its words are sent or it is given up
  let note = ""; // a word from the page itself for the status line

  const voice = new Narrator({ fetchSpeech: (text) => app.speech(text) });
  const microphone = new Microphone();
  const changed = () => onChange();

  // -------------------------------------------------------------------------
  // Joining and leaving

  // Joins the session the server has for this workspace. "absent" when the
  // server has none; "unreachable" when it cannot be asked.
  async function join() {
    if (joined) return;
    const mine = { leave: null };
    joined = mine;
    transcript = [];
    status = null;
    error = "";
    mine.leave = app.teacher.events((event, data) => {
      if (joined !== mine) return;
      if (event === "said") transcript[data.n] = data;
      else if (event === "status") {
        status = data.status;
        error = data.error ?? "";
      } else if (event === "act") perform(data);
      else if (event === "cut") cutShort(data.id);
      else if (event === "ended") {
        status = data.reason === "failed" ? "failed" : "ended";
        error = data.error ?? "";
        onEvent("ended", data);
      }
      changed();
    });
    try {
      const found = await app.teacher.status();
      if (joined !== mine) return;
      if (!found.on) {
        leave();
        onEvent("absent", found);
        return;
      }
      for (const line of found.transcript) transcript[line.n] ??= line;
      status ??= found.status;
      for (const waiting of found.acts ?? []) perform(waiting);
    } catch (fault) {
      if (joined !== mine) return;
      console.warn("MusicHands: the agent could not be joined.", fault);
      leave();
      onEvent("unreachable", fault);
    }
    changed();
  }

  function leave() {
    if (!joined) return;
    joined.leave?.();
    joined = null;
    cutShort(act?.id, { tell: false });
    paused = false;
    voice.stop();
    changed();
  }

  // -------------------------------------------------------------------------
  // What the agent asks of the screen

  // Performs an act, when this is the browser that plays the music, and
  // reports it done. A `cancel` undoes what can be undone when it is cut short.
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
      changed();
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
        app.change({ pose: { [hand]: fingers.length ? { fingers, press, hold: null, step: null } : null } });
        after(asked.pauseMs ?? 0, { placed: true });
        break;
      }
      case "play_moment":
        if (app.state.playing) app.change({ playing: false });
        app.change({ hands: stageHands(asked.hands), pose: NO_POSE });
        app.playMoment(asked.time);
        after(MOMENT_PAUSE, { played: true });
        break;
      case "play_notes":
        mine.cancel = playNotes(asked.steps, (result) => finish(result));
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
    changed();
  }

  // Plays freehand: each step puts the hands where it says and presses its
  // keys, for as long as it lasts; a hand with nothing to press in a step is
  // lifted where it is. Answers a cancel.
  function playNotes(steps, done) {
    if (app.state.playing) app.change({ playing: false });
    const used = HANDS.filter((hand) => steps.some((step) => step[hand].length));
    const hidden = used.filter((hand) => !app.state.hands[hand].show || !app.state.hands[hand].sound);
    if (hidden.length) app.change({ hands: Object.fromEntries(hidden.map((hand) => [hand, { show: true, sound: true }])) });
    const resting = { left: app.state.pose.left?.fingers ?? null, right: app.state.pose.right?.fingers ?? null };
    let timer = null;
    let at = performance.now();
    const lift = () => {
      const pose = {};
      for (const hand of HANDS) if (resting[hand]) pose[hand] = { fingers: resting[hand], press: [], hold: null, step: null };
      if (Object.keys(pose).length) app.change({ pose });
    };
    const next = (index) => {
      // Held where it is: the run waits, and goes on from this step when taken up again.
      if (paused) {
        timer = setTimeout(() => {
          at = performance.now();
          next(index);
        }, 100);
        return;
      }
      if (index === steps.length) {
        lift();
        return done({ played: true });
      }
      const step = steps[index];
      const pose = {};
      for (const hand of HANDS) {
        if (step[hand].length) {
          resting[hand] = step[hand];
          pose[hand] = { fingers: step[hand], press: step[hand].map((entry) => entry.note), hold: step.ms, step: index };
        } else if (resting[hand]) pose[hand] = { fingers: resting[hand], press: [], hold: null, step: index };
      }
      app.change({ pose });
      at += step.ms;
      timer = setTimeout(() => next(index + 1), Math.max(0, at - performance.now()));
    };
    next(0);
    return () => {
      clearTimeout(timer);
      lift();
    };
  }

  // Cuts the act short here: the voice and the music stop. With `tell`, the
  // agent is told it was interrupted (when the learner's words will not say so).
  function cutShort(id, { tell = false } = {}) {
    if (held && (id === undefined || held.id === id)) held = null;
    if (!act || (id !== undefined && act.id !== id)) return;
    const mine = act;
    act = null;
    mine.cancel?.();
    if (tell) app.teacher.done(mine.id, { interrupted: true, learner_said: "" }).catch(() => {});
    changed();
  }

  app.addEventListener("played", () => {
    if (act?.type !== "play" || act.loop) return;
    const mine = act;
    act = null;
    app.teacher.done(mine.id, { played: true }).catch(() => {});
    changed();
  });

  // -------------------------------------------------------------------------
  // The learner's hand on it: held where it is, and taken up again

  function pauseOrResume() {
    if (!joined) return;
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
    changed();
  }

  // -------------------------------------------------------------------------
  // What the learner says

  // Sends the learner's words to the agent, cutting short whatever the
  // screen was doing: the agent hears them in its place. Answers the
  // server's reply, or throws when it would not hear them.
  function sendWords(text) {
    const words = String(text ?? "").trim();
    if (!words) return Promise.resolve(null);
    if (act) {
      const mine = act;
      act = null;
      mine.cancel?.();
    }
    held = null;
    paused = false;
    voice.stop();
    transcript.push({ who: "learner", text: words }); // shown at once; the server's numbered copy takes its place
    changed();
    return app.teacher.say(words);
  }

  // The microphone, held: while it is down the voice and the music are
  // stopped so they are not heard as speech; what was said goes to `into`
  // when it is let go.
  async function holdMic(down, into) {
    if (down === listening) return;
    listening = down;
    root.body.classList.toggle("mic-down", down);
    changed();
    if (down) {
      if (act) {
        interrupted = act;
        act.cancel?.();
      }
      paused = false;
      voice.stop();
      try {
        await microphone.start();
      } catch (fault) {
        listening = false;
        root.body.classList.remove("mic-down");
        giveUp(`The microphone could not be used: ${fault.message}`);
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
      into(text);
    } catch (fault) {
      giveUp(`That could not be made out: ${fault.message}`);
    }
  }

  // Nothing came of the microphone: the act it cut short is reported so, with no words.
  function giveUp(why) {
    if (interrupted) cutShort(interrupted.id, { tell: true });
    interrupted = null;
    setNote(why);
  }

  function setNote(text) {
    note = text;
    changed();
  }

  // Holds the microphone down while a button is pressed.
  function micButton(button, into) {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      holdMic(true, into);
    });
    for (const name of ["pointerup", "pointercancel"]) button.addEventListener(name, () => holdMic(false, into));
  }

  return {
    watch: (handler) => {
      watchers.add(handler);
      return () => watchers.delete(handler);
    },
    join,
    leave,
    perform,
    cutShort,
    pauseOrResume,
    sendWords,
    holdMic,
    micButton,
    setNote,
    stopVoice: () => voice.stop(),
    setLead: (leads) => (lead = Boolean(leads)),
    lines: () => transcript.filter(Boolean),
    micAvailable: () => Microphone.supported && Boolean(app.site.ears),
    get joined() {
      return joined !== null;
    },
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get act() {
      return act;
    },
    get paused() {
      return paused;
    },
    get listening() {
      return listening;
    },
    get note() {
      return note;
    },
  };
}
