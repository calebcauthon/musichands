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
| `passage` | The measures Play keeps to, or `null` for the piece from here on: `{ "from": <measure index>, "to": <measure index>, "times": <how many times through, or null for over and over> }`, with optional `"start"` and `"end"` (quarter notes from the beginning of the piece) to keep it to part of those measures. Measure indexes count from 0. See "Playing a passage". |
| `pose` | A hand put where you say, not where the score has it: `{ "left": null \| { "fingers": [{ "finger": 1–5, "note": "C4" }], "press": ["C4"] }, "right": … }`. See "Posing a hand". |
| `lesson` | The lesson under way, or `null`: `{ mode, from, to, score, … }`. The workspace stores it as given; the page's learning modules and the teacher read it. See "Lessons". |

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

## Playing a passage

To play just some measures, at any speed, any number of times, set `passage`
with the tempo and start playing from its first measure (`time` is that
measure's start in quarter notes):

```sh
# Measure 5 alone, three times, at 50 beats a minute
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' \
  -d '{"passage": {"from": 4, "to": 4, "times": 3}, "tempo": 50, "time": 16, "playing": true}' $BASE/api/workspaces/$WS
```

Each go starts on the beat the last one ended on. After the last, `playing`
goes false; with `"times": null` it loops until stopped. The measures are
tinted in the notation. While `passage` is set, Play plays it again; send
`"passage": null` to give Play the whole piece back. `hands` chooses which
hand is seen and heard, as always. Add `"end": 18` (or `"start"`) to play
only part of the measures: up to beat 18 of the piece, say. Send `"end":
null` to have the whole of them again. A lesson works through this same field.

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

Learning is a module on the page (`learning.js`) with two ways of learning
a passage, each a module of its own. The lesson under way is kept in the
workspace as `lesson`, which the page's modules (and the teacher) read and
the server itself does not; `mode` says whose it is, `from` and `to` are
measure indexes from 0, `score` the piece.

**The drill** (`mode: "drill"`) is rigid and silent and needs nothing from
the server: the lead browser goes through a fixed list of steps (each hand
placed and held, then played slowly four times, faster twice, at tempo
twice; then the other hand; then both), keeping its place in `step`:

```json
{ "mode": "drill", "from": 2, "to": 5, "step": 0, "score": "<score id>" }
```

Write that (with `passage` to the measures, `time` to their start and the
camera overhead, as for the teacher below) to start one from outside; raise
`step` to move it on; send `"lesson": null, "passage": null` to stop.

**The teacher** (`mode: "teacher"`) is an agent on the server
(`teacher.js`) that is handed the music and the screen's tools and talks
with the learner. It is a model on OpenRouter; a site without
`OPENROUTER_API_KEY` has no teacher and answers `503` to all of this.

```json
{ "mode": "teacher", "from": 2, "to": 5, "style": "hands-separate", "score": "<score id>" }
```

`style` is a way of teaching: `lead` (the teacher decides),
`hands-separate` (right hand, then left, then both, slowly and then up to
tempo), `one-thing` (one spot drilled) or `play-along` (few words, loop and
speed up).

**Starting a lesson.** `POST /api/workspaces/<id>/teacher` with
`{ "from": 2, "to": 5, "style": "lead", "said": "I just want to learn this." }`
(`style` and `said` optional) starts one and answers `201` with its status.
The teacher sets `lesson`, `passage`, `time` and `camera` itself (straight
over the hands), so there is nothing else to send. `409` if one is already
on.

**What the teacher does.** It is told where each hand sits and every moment
it plays in the passage, with the fingering as it stands, and it works
through tools: say something, place a hand on the keys (`pose`), play one
moment, play the measures (`passage`, `tempo`, `hands`, `playing`) at a tempo
a few times or on a loop, pause, listen, look at other measures, change a
fingering (`corrections.fingers`), give a note to the other hand
(`corrections.hands`), move the lesson to other measures (`lesson`), and end.
The ones that touch the screen are performed by the lead browser, which
reports each done — the teacher's playing really waits for the music to play
out. You can read where it stands from the workspace fields as always.

**Talking to the teacher.** `POST /api/workspaces/<id>/teacher/say` with
`{ "text": "…" }` is the learner speaking: a word typed, the microphone, or
the Got it button (which sends `"Got it."`). If the teacher is listening it
hears it; if something is going on — a line being said, the passage playing
— that stops, the teacher is told it was interrupted and what was said, and
answers. Anyone with the token can do this, so another agent can prompt the
teacher on the learner's behalf.

**Following along.** `GET /api/workspaces/<id>/teacher` answers
`{ "on": true, "lesson": …, "status": "thinking" | "speaking" | "playing" |
"waiting" | "listening" | "failed", "transcript": [{ "n": 0, "who":
"teacher" | "learner", "text": "…" }], "acts": [ … ] }` (or `{ "on": false }`).
`GET /api/workspaces/<id>/teacher/events?token=<token>&client=<name>` is a
server-sent-events stream of the same: `said` (a transcript line), `status`,
`act` (something asked of the screen: `{ "id", "type": "say" | "pause" |
"place" | "play_moment" | "play", … }`), `cut` (an act cut short), and
`ended`. A browser that leads performs the acts and posts
`POST …/teacher/done` with `{ "id", "result" }`; if you are driving a
workspace no browser is open on, acts wait ten minutes for a screen and then
answer the teacher that none was there.

**Stopping.** `DELETE /api/workspaces/<id>/teacher` ends the lesson and puts
the piece back (`lesson`, `passage`, `tempo`, `hands`, `pose` to none). So
does sending `"lesson": null`, opening another piece, or opening the page on
a workspace with a lesson left in it.

`POST /api/workspaces/<id>/speech` with `{ "text": "…" }` answers that text
read aloud as MP3, from the voice the site is set up with (up to 1500
characters; `503` when the site has no voice). The voice is ElevenLabs'
Eleven v4, so the text may carry directions for the delivery in square
brackets: `"[gently] Thumb on A."`. The page uses it for lessons.

`POST /api/workspaces/<id>/hear` with a recording as the body (`content-type`
its kind, `audio/webm` say) answers `{ "text": "…" }`: what was said, by the
ears the site is set up with (ElevenLabs speech-to-text; `503` when it has
none). The page's microphone goes through it.

The workspace document (`GET /api/workspaces/<id>`) carries
`"site": { "voice": true, "teacher": true, "ears": true }` saying which of
these the site has.

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
