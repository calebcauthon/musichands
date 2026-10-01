# MusicHands

A browser prototype that shows where your hands go on a piano: a rigged 3D hand, posed by inverse kinematics, on a full 88-key keyboard.

## Run it

```bash
npm run dev
```

Then open the address it prints, normally <http://localhost:4173>; if that port is taken it uses the next free one. `npm run dev` (or `make dev`, `make dev PORT=5000`) runs `server.js`, which serves the app and keeps workspaces under `./data` (git-ignored). If that port is taken it uses the next free one. The pages use ES modules and fetch their assets, so they need a server; opening the HTML files directly will not work.

The front page is the sheet music view. The hand position studio, for shaping a single hand position finger by finger, is at `/studio.html` and is linked from the front page.

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
- `player-body.js` seats the player: a bench facing the middle of the keyboard, hips that stay where they are on it, a torso, and a shoulder either side. Each wrist is joined to its shoulder by an upper arm and a forearm of fixed length, so the elbow and the angle of the forearm follow from where the hand is. `solvePose` turns the hand toward its forearm and lets the wrist bend only as far as a wrist does, which is what makes a hand in front of the body point inward and one at the far end of the keyboard point outward. The torso leans from the hips only for a key the arm cannot reach, and a hand with nothing to play rests on the player's lap.
- `player-figure.js` draws that player: the bench, a suit closed at the collar, and a sleeve from each cuff back to its shoulder. Whatever comes within a few inches of the camera thins out, because the camera often sits where the player's head would be.
- `hand-stage.js` is the three.js scene: keys that dip and glow, lighting, the fallboard reflection, skin shading with nails, knuckle wrinkles and tendons, depth of field, and the camera that follows the hands.
- **Looks.** `looks.js` is a registry of named looks for each part of the picture: the piano (its lacquer, keys and felt), the player's build (man or woman: shoulder width, arm lengths, hand size), skin tone, clothes (suit, tuxedo, linen, clown), gloves, and the place (the dark stage, a park, a concert hall with an audience). A workspace's `look` names one of each, chosen under Appearance in the settings behind the gear, and everyone looking at the workspace sees the same. To add a look, add an entry to the right set in `looks.js`; the stage reads the spec and dresses itself. Places are built in `stage-scenes.js`, one function per place returning its scenery and lights; the figure takes its build and outfit from the spec; the skin shader takes its colours from it.
- `piano-audio.js` plays the recordings in `assets/piano/` through the Web Audio API, shifting the nearest recording to the note asked for, and falls back to a synthesised tone if they cannot be loaded. `hand-player.js` sequences notes through the hand and the piano together.
- The camera turns: drag on the stage to orbit the hands, and "Reset view" or a double-click below the keys goes back. A press that does not move is still a click on a key. Shift-drag or right-drag turns from anywhere without playing the key under the pointer. The sheet page keeps the camera in its workspace; the studio remembers its angle in the browser. `camera-orbit.js` holds the geometry.
- The camera bar along the bottom of the stage moves the camera closer or farther (− and +, or the wheel over the stage; it can back off far enough to see the whole place), saves the current position as a numbered view, and goes back to any saved view. Up to nine are kept; four come ready-made. On the sheet page "Auto cut" cuts to the next saved view at the start of a measure, once a shot has been held for about three seconds, and lets the camera creep slowly within each shot while the score plays. `camera-shots.js` holds the list and the timing.
- **Detail** (in Settings, behind the gear on the stage) sets how hard the stage works: *Full* is the cinematic look with depth of field, bloom, soft 2048-pixel shadows and up to 2× device pixels; *Balanced* drops the depth of field and halves the shadow map; *Light* draws without shadows or post-processing at 1× and caps the frame rate at 30. The choice is remembered on this machine. Until one is chosen the stage starts balanced and steps down on its own when frames keep falling behind (it says so in the console). Nothing is drawn while nothing moves.
- `hand-view.js` picks the 3D stage when WebGL 2 and three.js are available and falls back to the flat SVG drawing in `hand-keyboard.js` when they are not.

[three.js](https://threejs.org/) 0.170 is loaded from a CDN through the import map in each page.

The hand model is the generic hand from the [WebXR Input Profiles](https://github.com/immersive-web/webxr-input-profiles) assets package, used under its MIT license. The piano is the Salamander Grand Piano V3 by Alexander Holm, used under CC BY 3.0. See `assets/README.md`.

## Sheet music view

The front page is the line of music being played over the piano: a strip of notation, one line tall, that scrolls to the line the hands are on, above the stage. Play, the step buttons and the tempo float over the top of the stage; the song's name sits at the bottom, and clicking it opens the songs in the workspace. The gear at the top right holds the agent connection string, the manual and the notation colours. (`/sheet.html`, the old address, sends you there.)

- `score-model.js` reads MusicXML (via the tiny reader in `xml.js`) into a timeline of hand moments: which notes each hand holds at each beat. On a grand staff the top staff is the right hand. A piece set on more staves (Rachmaninoff's C-sharp minor prelude uses four) is read measure by measure: the staves in use are shared out, the top half to the right hand and the bottom half to the left, and a lone staff goes by its clef.
- `mxl.js` unpacks compressed `.mxl` files in the browser, so "Import a song…" accepts either format.
- `fingering.js` groups each hand's notes into positions that fit under one hand and chooses fingers for each position. Corrections made in the workspace win, then fingerings written in the score, then a heuristic guess. The page labels which one it used.
- The notation itself is drawn by [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/), loaded from a CDN; only the sheet view uses it.
- `ThumbnailRenderer` in `hand-stage.js` draws small stills of single hand positions with one shared offscreen stage; nothing on the sheet page uses it at the moment.

**Play** runs the piece from where you are, at the tempo on the slider, with both hands landing on the beat; P does the same. When the same workspace is open in more than one window, one of them plays the music and the rest follow; the status line says which, and pressing Play in a window makes it the one that plays. The tempo starts at the score's own. The slider runs from a quarter of that tempo to one and a half times it, so the score's tempo sits about 60% of the way along whatever the piece; marks under it show that tempo and a quarter, a half and three quarters of it, and clicking a mark sets it. The workspace's `reflexes` (how quickly the hands move and strike) has no control on the page any more; an agent can still set it. While playing, the hands always keep time: if the tempo leaves less room than the reflexes want, they hurry. `score-transport.js` does the timing.

**Learn** (beside Full screen, or L) teaches a passage, chosen in the notation: the measure on screen and the three after it are offered, tinted; click a measure to start there instead and another to end there, then Start learning (Enter; Escape cancels). The passage stays tinted while it is being learnt. It opens with the whole passage, both hands, at nearly full speed (“We're going to learn measures 1 to 4… Here it is at nearly full speed”), and then breaks it down by itself: right hand, then left, then both together. Each hand has four steps behind its own “Got it” (G): the voice places the hand a finger at a time (“Thumb on A… Finger 3 on C… Pinky on E”), and as each is named the hand on the stage puts that finger on its key and sounds it, so the position builds up in front of you (this goes through the workspace's `pose`, a hand position given directly that an agent can set too); then the voice names the notes in order with their fingers (“A, pinky. G, finger 4. A and F together, fingers 5 and 3”), the hand playing each as it is named, and the passage is played through twice for you to watch; then it plays through once, slowly (half the score's tempo), for you to play along; then it loops, and each “Got it” takes it up three beats a minute (“Now try 63”) until the score's own tempo. The camera goes straight over the hands and only the hand being learnt is shown and heard. The panel at the bottom left shows the step, what has been said, and Play/Pause, Restart (the passage from the top) and Again (hear the instructions again), besides Got it and Stop. All the other controls still work: change the tempo, step about, turn the camera. The lesson is part of the workspace (`lesson.js`), the once-through and the looping are the transport's (`score-transport.js`), and the voice is ElevenLabs through the server, which needs `ELEVENLABS_API_KEY` (and optionally `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`) in its environment; each line read is kept under `DATA_DIR/speech`, so the short lines that recur cost nothing the second time. Without a key the browser's own voice reads the lines instead (`speech.js`).

**Full screen** (the button beside the tempo, or F) gives that same block the whole screen. "Left hand only", "Both hands" and "Right hand only" at the bottom right choose which hands are seen and heard, the arrow keys and a click on a measure move through the piece, and Escape or F goes back. Where the browser will not hand over the screen, the page fills its window instead. `score-strip.js` works out where each line of music sits and how far to scroll. Full screen belongs to the browser it is switched on in; it is not part of the workspace.

**Corrections** to the fingering (a different finger for a note, or a note given to the other hand) live in the workspace, so everyone looking at it sees them, and an agent can make them through the API; the page has no control for them at the moment. A correction beats a fingering printed in the score. `corrections.js` applies hand moves and builds the correction maps.

A hidden hand is not drawn and none of its keys move or light up; a hand an agent has silenced but left showing is drawn but not heard. `hand-choices.js` works out what is drawn and heard.

A note tied over from before is held, not played again: its finger stays down, its key stays down, and the sound that started the tie rings through it. Only the notes that are not tied over are struck.

Step through the piece with the arrow keys or the ⇤ ← → buttons, or click a measure in the score. Each step sounds the notes struck at that moment. Space replays the moment together, Shift + Space one note at a time. **Finger numbers** (on the stage, or N) shows or hides the numbers over the keys.

Every workspace holds its own scores; none are shared by the whole site. A new workspace starts with a copy of each score named in `scores/starter.json`: the two that come with the app, both versions of Minor Descent, which were written for it. To change what newcomers start with, put a MusicXML file in `scores/` and add its name to that list. Bring in anything else with "Import a song…" (click the song's name); imported scores go into the workspace, in the server's data folder, and are not part of this repository.

## Workspaces and agents

Everything the sheet page shows is a **workspace**: a small JSON document on the server holding the score, the moment on screen, tempo, reflexes, whether it is playing, the camera (view, saved shots, auto cut), which hands are drawn and heard, finger numbers, sound, and every correction. The page only projects it. Reload and it is all still there; open the same link in another browser and both show the same thing and move together; the longest-connected browser plays the music for the others.

Each browser has one workspace of its own. A first visit makes it, already holding the starter scores, so there is nothing to set up; every later visit comes back to it, because the browser keeps its id and token. There is no list of workspaces to choose from. A workspace's link is `/#ws=<id>&token=<token>`; the token is the only credential, and it opens only that workspace. Opened in a browser with no workspace yet, the link becomes that browser's own, which is how to carry a workspace to another device. Opened in a browser that has one, it is a visit: "Back to my workspace" returns to the browser's own, which is left untouched.

**Copy agent connection string** (behind the gear) puts on the clipboard everything an agent needs: the site, the workspace id and token, and a link to the manual. Paste it into whatever agent you run — there is no chat box or model in the app — and ask it to look at what you are looking at. The manual, [`agent.md`](./agent.md) (served at `/agent.md`), covers the API: `GET /api/workspaces/<id>/screen` for what is on screen, `PATCH /api/workspaces/<id>` for changes (any field, including corrections such as `{"corrections":{"hands":{"5:2.5":{"C4":"right"}}}}`), `POST …/commands` to play or stop, a server-sent-events stream for following along, `POST /api/workspaces/<id>/scores` to add a piece, and `POST /api/workspaces` to make another workspace to experiment in.

`workspace-model.js` is the state's shape, cleaning and merging, and the screen projection; `workspace-client.js` is the page's side (events stream, batched patches); `server.js` keeps each workspace as `data/workspaces/<id>.json`, with its scores beside it as `data/workspaces/<id>/scores/<hash>.musicxml`.

## Importing scores

"Import a song…" in the songs dialog (click the song's name at the bottom of the stage) takes a PDF, MusicXML or MXL file; so does dropping one anywhere on the page. The piece is added to the workspace's scores (`POST /api/workspaces/<id>/scores`, addressed by content hash) and opened; the dialog lists everything the workspace holds, and "Remove this song" takes the open one out. `GET /api/workspaces/<id>/score` gives the open piece back as MusicXML.

### PDFs

Notation programs draw noteheads, rests, clefs and accidentals as characters of a music font, using the standard [SMuFL](https://www.smufl.org/) code points, and draw staves, stems and barlines as lines. A PDF exported from one therefore still says exactly which symbol is where, and the import reads that rather than looking at pixels.

- `pdf-reader.js` uses [pdf.js](https://mozilla.github.io/pdf.js/) 4.10, loaded from a CDN the first time a PDF is imported, to list every glyph, line and filled shape on each page.
- `pdf-score.js` finds the staves and barlines, reads each note's pitch from where it sits under the clef and key, works out durations from note shapes, beams, flags, dots and triplet marks, times each measure from the columns the notes are printed in, finds ties, and writes MusicXML. It also reads the title, composer and tempo.

What it reads: piano music on one to four staves, from PDFs that use a SMuFL font, which includes scores downloaded from MuseScore.

What it does not read: scanned pages (they hold only a picture), PDFs set in older music fonts with their own character codes, grace notes, repeats and voltas (played straight through), ottava lines, and fingerings printed in the score.

A measure whose notes do not add up to the time signature is named in the status line, so a misreading shows instead of passing silently.

## Deploying

`npm start` runs `server.js`, a server with no dependencies that listens on `$PORT`, serves the app's own files and nothing else, and keeps workspaces and their scores under `DATA_DIR` (default `./data`). Set `PUBLIC_URL` if the site is reached through a different address from the one the server sees.

It runs on [Railway](https://railway.com/) at <https://musichands-production.up.railway.app>, with a volume mounted at `/data` and `DATA_DIR=/data` set on the service. To put out a new version, run `railway up --service musichands` from this folder.

## Tests

```bash
npm test
```
