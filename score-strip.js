// In full screen the notation is a strip above the piano, one line of music
// tall. These work out where each line (a "system") sits in the drawing, how
// tall the strip must be, and how far to scroll it to show the line being
// played. Everything is in pixels from the top of the drawing.

// systems: [{ top, bottom }], the staves of each line from the top down.
// Returns a band for each that also takes in the room around its staves (chord
// names above, fingering below), so the bands cover the drawing from 0 to `height`.
export function systemBands(systems, height) {
  return systems.map((system, index) => ({
    top: index === 0 ? 0 : (systems[index - 1].bottom + system.top) / 2,
    bottom: index === systems.length - 1 ? Math.max(height, system.bottom) : (system.bottom + systems[index + 1].top) / 2,
  }));
}

// Which band a height in the drawing falls in; above the first is the first, below the last the last.
export function bandAt(bands, y) {
  const index = bands.findIndex((band) => y < band.bottom);
  return index === -1 ? bands.length - 1 : index;
}

// Tall enough for the tallest line, but no taller than `limit`.
export function stripHeight(bands, limit = Infinity) {
  if (!bands.length) return 0;
  return Math.min(limit, Math.max(...bands.map((band) => band.bottom - band.top)));
}

// How far down to scroll a strip `view` tall so a band sits in the middle of it.
export function stripScroll(band, view) {
  return Math.max(0, (band.top + band.bottom) / 2 - view / 2);
}
