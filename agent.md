# MusicHands for agents

MusicHands shows a piano score with two 3D hands playing it, one moment at a
time. Everything on the screen is a projection of a **workspace**: a small JSON
document on the server. Change the workspace and the screen changes, in every
browser looking at it. Click in the browser and the workspace changes, so you
can read what the person is looking at.

You were probably handed a connection string like this:

```
MusicHands workspace "Evening practice"
URL: https://musichands-production.up.railway.app
Workspace: ws-k3j9x2m1qa
Token: 5Qm...
Manual: https://musichands-production.up.railway.app/agent.md
```

`URL` is the site. `Workspace` is the id of the one workspace you may touch.
`Token` is its credential: send it as `Authorization: Bearer <token>` (or
`?token=<token>` on the URL). The token opens only that workspace. Never touch a
workspace you were not given, and do not paste tokens into places other people
can read.

## Ten-second start

```sh
BASE=https://musichands-production.up.railway.app
WS=ws-k3j9x2m1qa
AUTH="Authorization: Bearer $TOKEN"

# What is on the screen right now?
curl -s -H "$AUTH" $BASE/api/workspaces/$WS/screen | jq

# Go to measure 12 (see "Moments" for how time is counted)
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' \
  -d '{"time": 44}' $BASE/api/workspaces/$WS

# Put the left hand's 5th finger on the low G at measure 3, beat 1
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' \
  -d '{"corrections": {"fingers": {"3:1": {"left": {"G2": 5}}}}}' $BASE/api/workspaces/$WS

# Let the right hand take the C4 the score gives the left hand at measure 5, beat 2.5
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' \
  -d '{"corrections": {"hands": {"5:2.5": {"C4": "right"}}}}' $BASE/api/workspaces/$WS

# Play from here
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"type": "play"}' $BASE/api/workspaces/$WS/commands
```

The page updates within a moment of each call. Add `-H 'x-client: <your name>'`
to your requests so the page can say who made a change.

## The workspace document

`GET /api/workspaces/<id>` returns `{ id, name, token, url, api, manual,
connectionString, version, state, scores, updated }`. `scores` lists the pieces
the workspace holds (see "Scores"). `state` is the whole screen:

```json
{
  "score":   { "id": "9f2c…", "title": "Minor Descent" },
  "time":    0,
  "tempo":   null,
  "reflexes": 1,
  "playing": false,
  "camera":  { "view": { "azimuth": 0, "elevation": 72, "zoom": 1 }, "shots": null, "autoCut": false },
  "hands":   { "left": { "show": true, "sound": true }, "right": { "show": true, "sound": true } },
  "numbers": true,
  "sound":   true,
  "look":    { "piano": "ebony", "build": "man", "skin": "fair", "outfit": "suit", "gloves": "none", "scene": "stage" },
  "corrections": { "fingers": {}, "hands": {} },
  "command": null
}
```

| Field | Meaning |
| --- | --- |
| `score` | Which of the workspace's own scores is open: the `id` of an entry in `scores`. `title` is filled in by the server. An id the workspace does not hold is ignored. `null` only when the workspace has no scores. |
| `time` | The moment on screen, in quarter notes from the start of the piece. The page snaps to the last struck moment at or before this. |
| `tempo` | Quarter notes a minute when playing, 30–240. `null` means the score's own tempo (or 80 if it has none). |
| `reflexes` | How fast the hands move between chords, 0.5–4 (1 is natural). |
| `playing` | Whether the piece is running. The page sets it true/false as it plays; set it yourself or, better, send a `play` / `stop` command. |
| `camera.view` | Where the camera is: `azimuth` (degrees around the keyboard, 0 is straight on from the player's seat, positive swings to the player's right, −150…150), `elevation` (degrees above the keys, 6…89; 90 would look straight down), `zoom` (0.45…2.8, more is closer). |
| `camera.shots` | Saved camera positions the auto-cut cycles through, an array of `{ name, azimuth, elevation, zoom }`, or `null` for the built-in set. |
| `camera.autoCut` | Whether the camera cuts between the shots as the piece plays. |
| `hands.left`, `hands.right` | `show`: draw the hand; `sound`: let it be heard. |
| `numbers` | Show finger numbers over the keys. |
| `sound` | Master sound switch. |
| `look` | How the stage looks, one name for each part: `piano` (`ebony`, `white`, `rosewood`, `crimson`), `build` (`man`, `woman`), `skin` (`fair`, `olive`, `brown`, `dark`), `outfit` (`suit`, `tuxedo`, `linen`, `clown`), `gloves` (`none`, `white`, `black`) and `scene` (`stage`, `park`, `hall`). A name that does not exist falls back to the default. |
| `corrections.fingers` | `{ "<moment>": { "<hand>": { "<note>": <finger 1–5> } } }`. Overrides the score's and the app's fingering at that moment. See "Corrections". |
| `corrections.hands` | `{ "<moment>": { "<note>": "left" \| "right" } }`. Gives a note to the other hand at that moment. |
| `command` | The last command posted, `{ seq, type, by }`. Read-only in practice; use `POST .../commands`. |
| `pose` | A hand put where you say, not where the score has it: `{ "left": null \| { "fingers": [{ "finger": 1–5, "note": "C4" }], "press": ["C4"] }, "right": … }`. See "Posing a hand". |
| `lesson` | The passage being learnt, or `null`: `{ "from": <measure index>, "to": <measure index>, "stage": "right" \| "left" \| "both", "phase": "position" \| "show" \| "once" \| "ramp" }`. Measure indexes count from 0. See "Lessons". |

Every value is checked on the way in. Out-of-range numbers are clamped, and
anything the page cannot show is dropped, so read the response to see what
stuck.

## Reading the screen

`GET /api/workspaces/<id>/screen` is the workspace projected the way the page
projects it, so you can see what the person sees without rendering anything:

```json
{
  "workspace": { "id": "ws-…", "name": "Evening practice", "version": 7 },
  "score": { "title": "Minor Descent", "measures": 16, "tempo": 72 },
  "time": 8, "measure": "3", "beat": 1,
  "step": { "index": 5, "count": 40 },
  "hands": {
    "right": { "notes": [{ "note": "F4", "finger": 2, "held": false, "struck": true }], "fingeringFrom": "heuristic", "position": { "measures": "3–4", "fingers": {…} } },
    "left":  { "notes": [{ "note": "G2", "finger": 5, "held": false, "struck": true }, …], "fingeringFrom": "heuristic", "position": … }
  },
  "corrections": { "fingers": {…}, "hands": {…} },
  "state": {…}
}
```

`step` counts the struck moments of the piece: the page's ← → keys step through
them. `held` marks a note that is still sounding from a tie rather than being
played again. `fingeringFrom` is `"score"` when the score gives the fingering,
`"override"` when a correction does, and `"heuristic"` when MusicHands chose it.

`GET /api/workspaces/<id>/score` returns the open piece as MusicXML, if you
need to read the music itself.

## Moments

Corrections and the `time` field both name a place in the piece.

- `time` is quarter notes from the very beginning: measure 1 starts at 0; in
  4/4, measure 3 beat 1 is at `8`, measure 3 beat 2.5 is at `9.5`. A pickup
  measure counts only as long as it is.
- A **moment key** is `"<measure>:<beat>"`, using the score's own measure number
  and a beat within it counted from 1 in the measure's beat unit, so
  `"3:1"`, `"5:2.5"`. The `/screen` response gives you `measure` and `beat` for
  the moment on screen, ready to use as a key.

Notes are written as pitch letter, optional `#` or `b`, and octave: `C4` is
middle C, `G2`, `F#3`, `Bb4`.

## Corrections

**Fingers.** `corrections.fingers["3:1"].left.G2 = 5` puts the left hand's
fifth finger on G2 at measure 3, beat 1, and only there. To correct every
place where that hand plays the same set of notes, look them up in the score
(the page's "everywhere" button does this) and write each moment. To take a
correction back, send `null`:

```json
{ "corrections": { "fingers": { "3:1": { "left": { "G2": null } } } } }
```

**Hands.** `corrections.hands["5:2.5"].C4 = "right"` moves the C4 that sounds
at measure 5, beat 2.5 from whichever hand the score gave it to the right
hand. The note joins whatever the right hand plays at that instant (or makes a
new moment for it), the other hand lets it go, and the fingering of both hands
is worked out again around the change. A finger correction for a moved note
goes under its new hand. `null` gives the note back to the score's hand.

Corrections belong to the workspace, keyed by moment, so they only make sense
for the piece they were made on. When the page switches a workspace to another
piece it clears them; if you change `score` yourself, send
`"corrections": { "fingers": null, "hands": null }` too unless you mean to keep
them. Copy a workspace to try a different set.

## Posing a hand

`pose.right` (or `.left`) takes a hand off the score and puts it where you
say: `fingers` is which finger sits on which note, `press` which of those
keys are held down. The page draws the hand there, strikes and sounds the
pressed keys as the pose arrives, and leaves the rest of the screen alone;
`null` gives the hand back to the score. A pose is only shown while the piece
is not playing. The lesson's placement phase writes poses finger by finger as
the voice names them; you can do the same:

```sh
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' \
  -d '{"pose": {"right": {"fingers": [{"finger": 1, "note": "C4"}], "press": ["C4"]}}}' $BASE/api/workspaces/$WS
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' \
  -d '{"pose": {"right": {"fingers": [{"finger": 1, "note": "C4"}, {"finger": 3, "note": "E4"}], "press": ["E4"]}}}' $BASE/api/workspaces/$WS
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' \
  -d '{"pose": {"right": null}}' $BASE/api/workspaces/$WS
```

## Lessons

A lesson takes a few measures through three stages, `right` hand, then
`left`, then `both`, and each stage through four phases: `position` (the
voice places the hand a finger at a time; nothing plays), `show` (the voice
names the notes in order, the hand playing each, then the passage is played
twice to watch), `once` (the passage plays through once, slowly, about half
the score's tempo, for the person to play along) and `ramp` (the
passage loops, and each "got it" adds three beats a minute until the score's
own tempo). The practice tempo is the workspace's ordinary `tempo`; the hands
shown and heard are the ordinary `hands`; the placing phase writes `pose` as
each finger is named and clears it after; Play plays the passage, once or on a
loop as the phase has it. The page keeps the camera straight over the hands,
says what to do through a voice, and the person presses "Got it" to move on.
To start one, set it up the way the page does:

```json
{ "lesson": { "from": 2, "to": 5, "stage": "right", "phase": "position" }, "time": 8, "tempo": 60, "hands": { "left": { "show": false, "sound": false }, "right": { "show": true, "sound": true } }, "camera": { "view": { "azimuth": 0, "elevation": 87, "zoom": 1.35 }, "autoCut": false }, "playing": false }
```

The lead browser then talks the phase through and, in a phase that plays,
starts playing. Change `phase` or `stage` (with `hands`, `tempo` and `time` to
match) to move on; send `"lesson": null` to stop. Opening another score clears
the lesson.

`POST /api/workspaces/<id>/speech` with `{ "text": "…" }` answers that text
read aloud as MP3, from the voice the site is set up with (up to 1500
characters; `503` when the site has no voice). The page uses it for lessons.

## Changing the workspace

`PATCH /api/workspaces/<id>` with a JSON body lays your change over the state:
objects merge key by key, numbers/strings/arrays replace, `null` removes a key
(for `tempo`, `camera.shots` and `command`, `null` is the value "none"). Send
the fields you want changed and nothing else. The body may be the state change
itself, or `{ "state": {…}, "name": "New name" }` to rename as well. The
response is `{ version, state, name }`.

`PUT /api/workspaces/<id>` replaces the whole state (missing fields go back to
their defaults).

`POST /api/workspaces/<id>/commands` with `{ "type": … }` asks the page to do
something it can only do while running: `play` (from the current `time`),
`stop`, `replay-together` (sound the chord on screen), `replay-succession`
(one finger after another), `replay-roundtrip` (up and back down). When
several browsers watch a workspace, one of them (the "lead") plays the music
and runs commands; the others follow along. The lead is the browser that last
asked to be, which happens when someone presses Play there, else the longest
connected. `POST /api/workspaces/<id>/lead` with an `x-client` header names a
watching browser and makes it the lead.

`version` goes up by one with every change, whoever made it. Read it back
before assuming your change is the latest one.

## Watching for changes

`GET /api/workspaces/<id>/events?token=<token>&client=<name>` is a
server-sent-events stream. It sends the full workspace at once and again after
every change:

```
event: state
data: {"version":8,"state":{…},"name":"Evening practice","scores":[…],"by":"caleb"}
```

`by` is the `x-client` (or `?client=`) of whoever made the change, empty when
unknown. The page uses this same stream, so if you are on it you see exactly
what the page sees, as soon as it does. Polling `/screen` works too.

## Scores

Every workspace holds its own scores. There are no scores shared by the whole
site: a new workspace is given its own copies of a few starter pieces, and
anything added after that belongs to that workspace alone. All of these need
the workspace's token.

`GET /api/workspaces/<id>/scores` lists them: `{ scores: [{ id, title,
measures, added }] }`. The same list comes with the workspace document and
with every event on the stream, and it is what the page's score menu shows.

`POST /api/workspaces/<id>/scores` with a MusicXML body (`content-type:
application/vnd.recordare.musicxml+xml`, or JSON `{ "xml": "…", "title": "…" }`
to name it yourself) adds a piece and answers `{ id, title, measures, version,
scores }`. Then open it:

```json
{ "score": { "id": "<id>" }, "time": 0, "corrections": { "fingers": null, "hands": null } }
```

A score's id is the hash of its MusicXML, so adding the same file twice is
harmless. `GET /api/workspaces/<id>/scores/<score id>` returns the MusicXML and
`…/scores/<score id>/summary` its title, measure count and tempo.

`DELETE /api/workspaces/<id>/scores/<score id>` takes a piece out of the
workspace for good. If it was the one open, the workspace moves to its first
remaining score and the corrections are cleared.

## Other workspaces

Each person has one workspace: their browser is given it on the first visit
and comes back to it every time. You can still make others to experiment in.
`POST /api/workspaces` (no token needed) with an optional JSON body:

- `{ "name": "Try 4-1-2", "copyFrom": { "id": "<id>", "token": "<token>" } }`
  copies an existing workspace, scores and corrections and all, so you can
  experiment without disturbing the one the person is looking at.
- `{ "name": "Left hand only" }` makes a new one holding the starter scores.
- `{ "state": {…} }` does the same, starting from a state you give.

The answer (`201`) carries the new `id`, `token`, `url`
(`<site>/#ws=<id>&token=<token>`) and a `connectionString` you can hand to
another agent. Give the person the `url` if you want them to see your
workspace: it opens as a visit, with a "Back to my workspace" button, and
their own workspace is left as it was. There is no list of workspaces, and no
way to reach one without its token.

`DELETE /api/workspaces/<id>` removes a workspace and its scores for good.

## Errors

Every error is JSON `{ "error": "…" }`: `400` for a body that cannot be used,
`401` for a missing or wrong token, `403` for copying with the wrong token,
`404` for an unknown workspace or a score the workspace does not hold, `409`
when the workspace has no score open.
