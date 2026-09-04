# MusicHands hand-position visual

A dependency-free browser prototype for generating an SVG hand over a piano keyboard.

## Run it

```bash
npm run dev
```

Then open <http://localhost:4173>.

## What it does

- Assigns one piano note to each finger.
- Generates a responsive, player-view SVG with the wrist below the keys and fingers reaching away from the player.
- Highlights thumb and pinky anchors.
- Responds to pointer, computer-keyboard, and Web MIDI input.
- Downloads the current diagram as a standalone SVG.

The reusable renderer is exported from `hand-keyboard.js`; the surrounding editor lives in `app.js`.

## Tests

```bash
npm test
```
