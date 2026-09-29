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
- Plays a sampled grand piano: click any key, step through a score, or use the play buttons to hear a position all together, one finger at a time, or up through the fingers and back down, with the fingers striking in time with the sound.
- Responds to pointer, computer-keyboard, and Web MIDI input.
- Downloads the current picture as a PNG.

## How the hand works

- `assets/hand-right.glb` is a rigged hand mesh with 25 joints. The left hand is the same mesh mirrored.
- `glb-skeleton.js` reads the joint layout out of that file, and `hand-rig.js` turns it into a rigid skeleton. A pose is only the hand's position and turn plus joint angles, so bones cannot change length.
- `solvePose` in `hand-rig.js` finds the pose whose fingertips sit on their keys while staying close to a relaxed playing shape. Fingertips may slide along a key, idle fingers hover, knuckles clear the black keys, and a span the hand cannot cover grows the whole hand slightly rather than stretching a finger.
- `piano-geometry.js` lays out a real keyboard in metres, including the offset black keys and the narrow strip of white key between them.
- `hand-stage.js` is the three.js scene: keys that dip and glow, lighting, the fallboard reflection, skin shading with nails, knuckle wrinkles and tendons, depth of field, and the camera that follows the hands.
- `piano-audio.js` plays the recordings in `assets/piano/` through the Web Audio API, shifting the nearest recording to the note asked for, and falls back to a synthesised tone if they cannot be loaded. `hand-player.js` sequences notes through the hand and the piano together.
- The camera turns: drag on the stage to orbit the hands, and "Reset view" or a double-click below the keys goes back. A press that does not move is still a click on a key. Shift-drag or right-drag turns from anywhere without playing the key under the pointer. Each page remembers its angle. `camera-orbit.js` holds the geometry.
- The camera bar along the bottom of the stage moves the camera closer or farther (− and +), saves the current position as a numbered view, and goes back to any saved view. Up to nine are kept, shared by both pages; four come ready-made. On the sheet page "Auto cut" cuts to the next saved view at the start of a measure, once a shot has been held for about three seconds, and lets the camera creep slowly within each shot while the score plays. `camera-shots.js` holds the list and the timing.
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

**Play** runs the piece from where you are, at the tempo on the slider, with both hands landing on the beat; P does the same. The tempo starts at the score's own. **Reflexes** sets how quickly the hands move and strike, so stepping by hand can keep up with a fast piece. While playing, the hands always keep time: if the tempo leaves less room than the reflexes want, they hurry. `score-transport.js` does the timing.

Step through the piece with the arrow keys or the Next button, click a measure in the score, or click a position card to jump. Each step sounds the notes struck at that moment. Space replays the moment together, Shift + Space one note at a time, and the Sound switch turns it all off.

Scores live in `scores/`. The bundled `roundball-rock.musicxml` came from a MuseScore export and carries no fingerings, so nearly every position there is a guess until the sidecar file fills them in.

## Importing scores

"Import a score…" on the sheet page takes a PDF, MusicXML or MXL file; so does dropping one anywhere on the page. Imported scores are kept in the browser (IndexedDB) and listed under "Your scores". "Save MusicXML" writes the current one out as a file, which is also the way to correct a misread score in a notation program and bring it back.

### PDFs

Notation programs draw noteheads, rests, clefs and accidentals as characters of a music font, using the standard [SMuFL](https://www.smufl.org/) code points, and draw staves, stems and barlines as lines. A PDF exported from one therefore still says exactly which symbol is where, and the import reads that rather than looking at pixels.

- `pdf-reader.js` uses [pdf.js](https://mozilla.github.io/pdf.js/) 4.10, loaded from a CDN the first time a PDF is imported, to list every glyph, line and filled shape on each page.
- `pdf-score.js` finds the staves and barlines, reads each note's pitch from where it sits under the clef and key, works out durations from note shapes, beams, flags, dots and triplet marks, times each measure from the columns the notes are printed in, finds ties, and writes MusicXML. It also reads the title, composer and tempo.

What it reads: piano music on one or two staves, from PDFs that use a SMuFL font, which includes scores downloaded from MuseScore.

What it does not read: scanned pages (they hold only a picture), PDFs set in older music fonts with their own character codes, grace notes, repeats and voltas (played straight through), ottava lines, and fingerings printed in the score.

A measure whose notes do not add up to the time signature is named in the status line, so a misreading shows instead of passing silently.

## Tests

```bash
npm test
```
