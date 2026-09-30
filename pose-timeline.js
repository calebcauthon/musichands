// Advance an animation on absolute time. A missed frame consumes time from
// subsequent segments too; it never adds another frame's delay to each joint move.
export function advanceSegments(segments, now, apply, blend) {
  while (segments.length) {
    const segment = segments[0];
    segment.start ??= now;
    const end = segment.start + segment.duration;
    if (now >= end) {
      segments.shift();
      if (segments.length) segments[0].start ??= end;
      segment.done?.();
      if (segments.length) continue;
      // An exit callback may hide/reset the actor; apply the final pose first
      // only for ordinary moves without an exit callback.
      if (!segment.done) apply({ pose: segment.to.pose.slice(), scale: segment.to.scale });
      return false;
    }
    const t = Math.max(0, (now - segment.start) / segment.duration);
    const state = blend(segment.from, segment.to, segment.ease(t));
    state.pose[1] += Math.sin(Math.PI * t) * segment.arc;
    apply(state);
    return true;
  }
  return false;
}
