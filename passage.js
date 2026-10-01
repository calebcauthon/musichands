// A passage: a stretch of whole measures of the piece, by measure index from
// 0. These find where it sits in the score's time and among its steps.

// Where the passage sits in the piece, in quarter notes: [start, end), with
// the score's own numbers for its first and last measures.
export function passageRange(passage, measures) {
  if (!measures.length) return null;
  const first = measures[Math.min(passage.from, measures.length - 1)];
  const last = measures[Math.min(passage.to, measures.length - 1)];
  return { start: first.start, end: last.start + last.length, from: first.number, to: last.number };
}

// The steps the passage covers: the first and last indexes in `steps` whose
// time falls in the range, or null if none does.
export function passageSteps(range, steps) {
  const first = steps.findIndex((step) => step.time >= range.start - 1e-6);
  if (first === -1 || steps[first].time >= range.end - 1e-6) return null;
  let last = first;
  while (last + 1 < steps.length && steps[last + 1].time < range.end - 1e-6) last += 1;
  return { first, last };
}
