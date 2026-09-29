# MusicHands

A browser prototype that shows where your hands go on a piano: a rigged 3D hand, posed by inverse kinematics, on a full 88-key keyboard.

## Run it

```bash
npm run dev
```

Then open the address it prints, normally <http://localhost:4173>. If that port is taken it uses the next free one. The pages use ES modules and fetch their assets, so they need a server; opening the HTML files directly will not work.

## What it does

- Assigns one piano note to each finger and poses the hand so every fingertip rests on its key.
- Draws both hands on one keyboard, seen from above the player, and animates each move and key strike.
- Plays a sampled grand piano: click any key, step through a score, or use the play buttons to hear a position all together or one finger at a time, with the fingers striking in time with the sound.
- Responds to pointer, computer-keyboard, and Web MIDI input.
- Downloads the current picture as a PNG.

## How the hand works

- `assets/hand-right.glb` is a rigged hand mesh with 25 joints. The left hand is the same mesh mirrored.
- `glb-skeleton.js` reads the joint layout out of that file, and `hand-rig.js` turns it into a rigid skeleton. A pose is only the hand's position and turn plus joint angles, so bones cannot change length.
- `solvePose` in `hand-rig.js` finds the pose whose fingertips sit on their keys while staying close to a relaxed playing shape. Fingertips may slide along a key, idle fingers hover, knuckles clear the black keys, and a span the hand cannot cover grows the whole hand slightly rather than stretching a finger.
- `piano-geometry.js` lays out a real keyboard in metres, including the offset black keys and the narrow strip of white key between them.
- `hand-stage.js` is the three.js scene: keys that dip and glow, lighting, the fallboard reflection, skin shading with nails, knuckle wrinkles and tendons, depth of field, and the camera that follows the hands.
- `piano-audio.js` plays the recordings in `assets/piano/` through the Web Audio API, shifting the nearest recording to the note asked for, and falls back to a synthesised tone if they cannot be loaded. `hand-player.js` sequences notes through the hand and the piano together.
- `hand-view.js` picks the 3D stage when WebGL 2 and three.js are available and falls back to the flat SVG drawing in `hand-keyboard.js` when they are not.

[three.js](https://threejs.org/) 0.170 is loaded from a CDN through the import map in each page.

The hand model is the generic hand from the [WebXR Input Profiles](https://github.com/immersive-web/webxr-input-profiles) assets package, used under its MIT license. The piano is the Salamander Grand Piano V3 by Alexander Holm, used under CC BY 3.0. See `assets/README.md`.

## Sheet music view

Open `/sheet.html` on the same server to see a whole piece with hand positions.

- `score-model.js` reads MusicXML (via the tiny reader in `xml.js`) into a timeline of hand moments: which notes each hand holds at each beat, split by staff.
- `mxl.js` unpacks compressed `.mxl` files in the browser, so the "Open MusicXML…" button accepts either format.
- `fingering.js` groups each hand's notes into positions that fit under one hand and chooses fingers for each position. Fingerings written in the score win, then entries in `scores/<name>.fingering.json` (keyed `"measure:beat"`), then a heuristic guess. The page labels which one it used.
- The notation itself is drawn by [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/), loaded from a CDN; only the sheet view uses it.
- Each position card is a still rendered by one shared offscreen stage, drawn only when the card scrolls into view.

Step through the piece with the arrow keys or the Next button, click a measure in the score, or click a position card to jump. Each step sounds the notes struck at that moment. Space replays the moment together, Shift + Space one note at a time, and the Sound switch turns it all off.

Scores live in `scores/`. The bundled `roundball-rock.musicxml` came from a MuseScore export and carries no fingerings, so nearly every position there is a guess until the sidecar file fills them in.

## Tests

```bash
npm test
```
