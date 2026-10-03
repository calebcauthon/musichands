// The drill: a rigid way of learning a passage, with nobody talking. Each
// hand that plays is taken on its own, then both together. For each: the
// hand is put in its position on the screen and held there a few seconds;
// then the passage is played through slowly several times, with a gap
// between, and again a little faster, and again at full tempo. The plan is
// a fixed list of steps worked out here from the music; the page
// (learning-drill.js) goes through them one by one.
import { handMoments, handPositions, lessonRange } from "./lesson.js";

export const DRILL = {
  hold: 3000, // ms the position is held on the screen before the playing starts
  gap: 2500, // ms between one time through and the next
  rounds: [
    { share: 0.5, times: 4, name: "slowly" },
    { share: 0.75, times: 2, name: "a little faster" },
    { share: 1, times: 2, name: "at full tempo" },
  ],
};

const STAGE_NAMES = { right: "Right hand", left: "Left hand", both: "Both hands" };

// The stages a drill on the passage has: each hand that plays, then both when both do.
export function drillStages(lesson, music) {
  const range = lessonRange(lesson, music.score.measures);
  if (!range) return [];
  const hands = ["right", "left"].filter((hand) => handMoments(music.events, hand, range).length);
  return [...hands, ...(hands.length === 2 ? ["both"] : [])];
}

// The tempo of a round: a share of the score's, never slower than the transport plays.
export function roundTempo(round, target) {
  return round.share >= 1 ? target : Math.max(30, Math.round(target * round.share));
}

// Every step of the drill, in order: for each stage, the position shown and
// held, then each time through each round.
export function drillSteps(lesson, music, settings = DRILL) {
  const target = music.tempo;
  const steps = [];
  for (const stage of drillStages(lesson, music)) {
    const name = STAGE_NAMES[stage];
    steps.push({ stage, kind: "show", label: `${name} · the position`, tempo: roundTempo(settings.rounds[0], target), hold: settings.hold });
    settings.rounds.forEach((round, at) => {
      const tempo = roundTempo(round, target);
      for (let time = 1; time <= round.times; time += 1) {
        steps.push({ stage, kind: "play", label: `${name} · ${round.name}, ${tempo}`, tempo, round: at, time, times: round.times, gap: settings.gap });
      }
    });
  }
  return steps;
}

// The hands put in their first position of the passage, for a "show" step:
// every finger of the position on its key, nothing pressed.
export function drillPose(stage, lesson, music) {
  const range = lessonRange(lesson, music.score.measures);
  const pose = { left: null, right: null };
  for (const hand of stage === "both" ? ["right", "left"] : [stage]) {
    const first = handPositions(music.positions, hand, range)[0];
    if (first) pose[hand] = { fingers: first.fingers.map(({ finger, note }) => ({ finger, note })), press: [] };
  }
  return pose;
}

// Where the drill is, for the panel: "3 of 24".
export function drillProgress(step, steps) {
  const at = steps.indexOf(step);
  return at < 0 ? "" : `${at + 1} of ${steps.length}`;
}
