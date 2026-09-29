// What the player has chosen to see and hear of each hand.

export const HANDS = ["left", "right"];

export function defaultChoices() {
  return { left: { show: true, sound: true }, right: { show: true, sound: true } };
}

// Stored choices, with anything missing or odd left at its default.
export function readChoices(text) {
  const choices = defaultChoices();
  try {
    const stored = JSON.parse(text);
    for (const hand of HANDS) {
      for (const what of ["show", "sound"]) {
        if (typeof stored?.[hand]?.[what] === "boolean") choices[hand][what] = stored[hand][what];
      }
    }
  } catch {
    // Nothing usable was stored.
  }
  return choices;
}

// Splits a moment of the score by those choices. `moment` maps each hand to
// { sounding: [midi], struck: [{ midi }] }.
//   shown:  the hands to draw, by name
//   ghost:  keys that go down with no hand on them, because their hand is hidden
//   heard:  the struck notes to sound
export function applyChoices(moment, choices) {
  const shown = [];
  const ghost = { held: [], struck: [] };
  const heard = [];
  for (const hand of HANDS) {
    const entry = moment[hand];
    if (!entry) continue;
    const struck = new Set(entry.struck.map((note) => note.midi));
    if (choices[hand].show) shown.push(hand);
    else {
      ghost.struck.push(...struck);
      ghost.held.push(...entry.sounding.filter((midi) => !struck.has(midi)));
    }
    if (choices[hand].sound) heard.push(...entry.struck);
  }
  return { shown, ghost, heard };
}
