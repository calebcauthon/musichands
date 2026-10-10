// Ways of teaching. A style is a set of instructions the teacher is given
// along with the music, not a script: the teacher decides what to do at
// each moment and the learner can always turn it another way. The page shows
// the names and blurbs; the server puts the instructions before the teacher.

export const STYLES = [
  {
    id: "lead",
    name: "You lead the way",
    blurb: "The teacher decides how to go about it.",
    instructions: `The learner wants to learn this passage and leaves the method to you. Do not interview them: at most one short question, if something really matters, and otherwise just begin. Unless they say otherwise, take each hand on its own first, a measure or a phrase at a time, slowly; then both hands together, slowly; then bring the tempo up in small steps. Shorten or skip any of that for music that does not need it, and change course the moment the learner asks for something else.`,
  },
  {
    id: "hands-separate",
    name: "Hands separate, then together, then faster",
    blurb: "Right hand first, then left, then both, slowly and then up to tempo.",
    instructions: `Teach in this order, and say so in a few words at the start:
1. Right hand alone. Learn its notes a measure (or a phrase) at a time: place the fingers it needs, name each new note finger first, play the piece so far, let the learner try. When the hand has the whole passage, loop it at a slow tempo and raise the tempo a few beats a minute each time the learner says they have it, until it is comfortable (not necessarily the score's tempo yet).
2. Left hand alone, the same way.
3. Both hands together, slowly: the first moment together, then adding a moment at a time, playing the passage so far each time; then the whole passage.
4. Tempo: loop the passage with both hands and raise it about three beats a minute at each "got it", up to the score's tempo.
A hand that plays only a note or a chord in the passage has nothing to build: place it, play it, move on.`,
  },
  {
    id: "one-thing",
    name: "Just this bit",
    blurb: "One spot, one problem: drill it until it goes.",
    instructions: `The learner has one particular thing in mind: a spot, a join, a jump, a fingering, a rhythm. Find out what it is if they have not said (one question), then work on just that. No routine: no whole-passage run-through, no hands-separate sequence unless that is the way through the problem. Isolate the moments in question, slow them right down, loop them, change the fingering if that is what is in the way, and stop as soon as the learner is happy.`,
  },
  {
    id: "play-along",
    name: "Play along",
    blurb: "Few words. Play it, loop it, and speed up when they say so.",
    instructions: `The learner wants to play along with the hands on the screen more than to be talked to. Keep talking to a minimum: say where you are starting and at what tempo, then play. Loop the passage so they can play with it; when they say they have it, raise the tempo a few beats a minute and loop again, up to the score's tempo. Only break the music up (one hand, a shorter stretch) when they ask, or when they keep stumbling in one place.`,
  },
];

export const DEFAULT_STYLE = STYLES[0].id;

// The style with that id, or the default.
export function findStyle(id) {
  return STYLES.find((style) => style.id === id) ?? STYLES[0];
}

export function cleanStyle(id) {
  return findStyle(String(id ?? "")).id;
}
