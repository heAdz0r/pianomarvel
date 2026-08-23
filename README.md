# Piano Marvel Uploader

A local tool: point it at one file of a piece (PDF, MIDI, MusicXML, mp3 or an
image) — every other file with the same name is found automatically in the same
folder, the form is pre-filled, you review and correct the metadata, and one
button uploads it to pianomarvel.com through a real browser session
(Playwright), instead of clicking through the slow form on the site by hand.

## Install

```bash
bun install
```

This also installs the headless Chromium that Playwright needs (`postinstall`).

## Run

```bash
bun run dev
```

Starts the API (port 3001) and the web interface (http://localhost:5173).

### Signing in to Piano Marvel (from the UI)

Login status is shown at the top of the page. Press **"Sign in to Piano
Marvel"**: the application opens a separate window of your normal, installed
Google Chrome. Sign in to Piano Marvel through Google and wait until you are
returned to the site. Then press **"I'm signed in — check"** in the uploader.
The application shuts the separate Chrome down, attaches to the saved profile,
verifies the session and enables uploading.

Google OAuth is deliberately not performed inside Playwright: Google rejects
automated browsers as unsafe. Your password never passes through this code.
Cookies live only in `.browser-profile/` (which is in `.gitignore`) and survive
restarts; if the session expires, press "Sign in" again.

> Port 3001 already taken at startup? An old server process is still running:
> `pkill -f server/index.ts`, then `bun run dev`.
>
> There is also an optional CLI login, `bun run login` (the same normal Chrome)
> — but do not run it at the same time as `bun run dev`: the browser profile can
> only be open in one process.

Then:

1. Press "Browse…" and pick a single file (for example
   `gymnopedie-no-1-satie.pdf`) — or simply paste the path as text.
2. The tool finds `.mid`, `.mxl`/`.musicxml`, `.pdf`, `.mp3`/`.wav`/`.m4a` and
   `.png`/`.jpg` in the same folder. Word order and filler parts of the filename
   such as `cover`, `score` or `piano` do not break the match.
3. MXL/MusicXML fills in the exact title, composer, copyright and tempo. Genre
   is determined locally from the metadata; difficulty 1–18 comes from note
   density, polyphony, rhythm, accidentals, range and score length. Review the
   suggested values before submitting.
4. "Upload to Piano Marvel" fills and submits the form through Playwright; the
   result (success plus a link, or an error) appears below the button and in a
   toast. If Learn Mode is enabled, the same toast keeps showing the queue, the
   current step, and either the successful outcome or the exact training error.
   Learn Mode creation is enabled by default for Learn & Play.
5. The catalogue below lists all My Uploads: you can check status, and create or
   resume training for any piece that is already uploaded.

The catalogue and Learn Mode verification results are stored in a local SQLite
cache, `.data/pianomarvel.sqlite`. Opening the interface does not start a
browser and does not contact Piano Marvel. A fresh catalogue, a single piece or
the whole library can be refreshed explicitly from the UI; those operations run
in headless Chrome. Every row shows the full timestamp of its last check. An
explicit live command restores the saved session by itself after a server
restart, so the check buttons do not require a separate sign-in first. New
pieces discovered during a manual catalogue refresh are checked and cached
immediately.

`OK` means an exact match with the target scheme, `WARN` means non-target
training is present, `NO` means there is no training. For `WARN` and `NO` the
old Whole/Chopped/Minced are replaced with a clean baseline and rebuilt: Whole
gets RH/LH, Chopped gets only the two-hand learning route of the selected
strategy, Minced gets combined/RH/LH variants. Slow/Medium/Fast are 60%/80%/100%
of the original Fast BPM, clamped to 30–240.

Creation does not rely on fixed multi-second pauses: the headless pipeline waits
for a specific model or button to become ready and continues immediately. In the
Predict strategy consecutive fragments are stored in checkpoint batches; if the
site's local model has not refreshed, the code safely falls back to Save after
every step. In the Adaptive strategy the finished MusicXML plan is written in a
single pass and confirmed by a hard reload from the server. Exact progress,
duration and error are visible in the UI. On failure the server writes a
step-by-step log and a diagnostic screenshot to `.data/learn-debug/`, after
which the operation can be restarted with the "Retry" button.

The "Refresh all" button queues every `WARN`/`NO`/failed record in FIFO order.
By default three independent lanes run concurrently (`LEARN_CONCURRENCY`): one
persistent context and two isolated worker contexts seeded with its cookies and
localStorage. Each worker gets its own `slicingData`, so parallel pieces do not
overwrite each other's state.

## Adaptive MusicXML: score to learning route

Adaptive is a local, score-derived algorithm that reads MusicXML as a map of
performance. Eight layers of analysis: notation form; melodic relief (LBDM,
melodic rests); harmony (key, chord roots, cadences); repetition and form
(bar-level self-similarity, novelty, section graph); hypermeter (period **and**
phase); motor load on musical time (stretch, polyrhythm, pedal); expressive
gestures; performance order (repeats, voltas, `D.S.`, `To Coda`).

Every signal type is weighted by how informative it is *in this score*
(`log(1/p)/log(N)`): a feature that fires at almost every barline distinguishes
nothing, while a rare one carries the most information. There are no absolute
thresholds.

A pedagogical hierarchy is built from those signals:

```text
Phrase → Bridge → Review → Summarize 1/3–3/3 → Whole
```

- **Phrase** keeps a complete musical thought intact and balances its real
  duration at Slow tempo against technical load.
- **Bridge** trains each seam and each internal expressive transition
  separately; the context size is computed in musical time.
- **Review** joins several complete Phrases into a formally meaningful block.
- **Summarize** splits the piece into three large musical parts. These are not
  mechanical 33% cuts: both boundaries are optimised jointly between Phrases,
  with priority given to form and to preserving ties, tempo and dynamic
  gestures.
- **Whole** completes the route with a performance of the full form.

There are no rules keyed to specific titles, files or bar numbers. Confidence is
computed separately for form, expression, motor load and the accuracy of the
MusicXML-to-Piano-Marvel mapping. The corpus audit covers 20 MXL paths / 18
unique scores across genres and computes musical metrics (boundary closure,
hypermeter alignment, formal seam coverage, duration spread, forced cuts,
performance-order breaks, comparison against expert annotation). Current values
and an honest list of targets not yet reached are in
[docs/adaptive-quality-report.md](docs/adaptive-quality-report.md).

A detailed description of the algorithm, its invariants, the corpus and the
methodological basis is in [docs/adaptive-learning.md](docs/adaptive-learning.md).
Primary sources:
[MusicXML 4.0](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/direction/),
[Chuan & Chew](https://kclpure.kcl.ac.uk/portal/en/publications/a-dynamic-programming-approach-to-the-extraction-of-phrase-bounda/),
[Chaffin et al.](https://production.wordpress.uconn.edu/musiclab/wp-content/uploads/sites/290/2013/10/Seeing-the-Big-Picture-Piano-Practice-as-Expert-Chaffin-2003.pdf),
[Shih, Hirano & Furuya](https://pmc.ncbi.nlm.nih.gov/articles/PMC12816802/) and
[Mazzola](https://link.springer.com/book/10.1007/978-3-319-64364-9).

## Fingering compiler

A second local engine annotates a score with fingering. The ergonomic core is
the model of Parncutt et al. (1997) with the refinements of Jacobs (2001): a
difficulty score built from twelve rules over hand-span matrices, searched with
a beam over hand events. Everything is deterministic and every digit is
traceable to a specific rule.

Three additions go beyond the published model, because it was calibrated on slow
single-voice fragments:

- **Real time.** Tempo is read from `<sound tempo>` and `<metronome>`, and each
  hand event carries the real interval since the previous attack. Motion rules
  (position change, thumb passing, hand shift, finger repetition) scale with
  speed; posture rules (stretches, weak finger, black keys) scale with its
  square root, because a held shape suffers less from speed than a movement.
- **One hand shape per repeated figure.** Cycles are found by self-similarity of
  event signatures, with no musical templates. A second pass then reduces every
  occurrence to a single hand shape, choosing only among shapes the full-context
  search actually produced, plus a penalty for changing the finger on a pitch
  shared with a neighbouring figure. A third pass does the same for identical
  material that recurs later in the piece.
- **Reachability.** A finger repeated on a different key is physically
  impossible unless it is a repeated note, a black-to-white slide, or a leap
  wider than a fifth. That constraint used to be checked only under slurs.

Both quality metrics are reproducible:

```bash
bun run bench:fingering -- <directory>   # agreement with published fingering
bun run audit:fingering -- <directory>   # physical defects, across every piece
```

The two are complementary. Agreement is measured against a handful of annotated
files, half of which are Hanon, whose printed fingering is a training convention
rather than an optimum. The audit looks at the output directly and counts
passages that cannot be played. The full design, the measurements and the
alternatives that were tried and rejected are in
[docs/fingering-prd.md](docs/fingering-prd.md).

## Downloading from MuseScore and the "are you human" check

Downloads run in a managed window of real Chrome with a persistent profile. If
MuseScore shows a Cloudflare check, the task **does not fail**: the window is
raised to the foreground, the progress display asks you to confirm, and work
continues by itself as soon as the check passes. The signal is the disappearance
of the check widget, not elapsed time; the emergency ceiling is
`MUSESCORE_HUMAN_CHECK_CAP_MS` (five minutes by default). A passed check stays in
the Chrome profile, so you confirm once rather than for every score.

User-agent and `navigator.webdriver` spoofing has been removed from the context:
Playwright rewrites only the UA string, not the client hints (`Sec-CH-UA`), so
the headers claimed one Chrome version while the hints reported the real one.
The check compares them against each other and would not accept the
confirmation even when the box was ticked by hand.

### File layout: artist → piece → set

Downloaded files are placed as
`musescore_sheets/<artist>/<piece>/<name>.{mxl,mid,mp3,pdf}`. A derived score is
kept next to its set in
`musescore_sheets/<artist>/<piece>/fingered/<name>.mxl`; the original is never
overwritten. A separate folder per piece is needed because one artist may have
many works, and one work may have MXL, MIDI, MP3, PDF and a fingered version.

The folder is chosen before the download, when the file does not exist yet, so
the artist is initially taken from the MuseScore page — whose fields are filled
in by whoever uploaded it. After downloading, the layout is realigned to the
information **from the score itself** (`<work-title>` and
`<creator type="composer">` in MusicXML are written by whoever engraved it), the
whole set is moved, empty old folders are removed, and `score_sources.xml_path`
is atomically re-pointed at the new MXL. An occupied path is never overwritten:
the identity of the piece gets a stable suffix.

Two rules cut out the noise that used to produce folders like `radioactive` and
`unknown`:

- a "composer" that matches the title is not treated as an author — the next
  candidate (the performer) is used, otherwise `unknown`;
- a heading such as "Radioactive - Imagine Dragons | Piano" is parsed: the title
  goes into the filename, the performer into the author candidates.

The same order of precedence is applied to the Piano Marvel form fields: score
first, then the MuseScore page, then the filename. Previously the page came
first, and whatever the uploader typed ended up in the title.

For an already downloaded corpus there is an idempotent migrator:

```bash
bun run server/musescore-relayout.ts          # plan only
bun run server/musescore-relayout.ts --apply  # move sets and re-point the database
```

If the check still refuses to pass, the cause is outside this code — IP
reputation (VPN), a wrong system clock, or Cloudflare policy towards managed
browsers. The working way around it: download the file in a normal browser and
attach it with the "Attach XML" button — Adaptive then works entirely locally.

## How it is put together

- `server/fileMatcher.ts` — finds neighbouring files by name and extension.
- `server/metadata.ts` — fallback guess of title and composer from the filename.
- `server/scoreAnalyzer.ts` — local MXL/MusicXML parsing: metadata, tempo, genre
  and heuristic difficulty 1–18.
- `server/genres.ts` — the "genre name → id" table (regenerated by `bun run scrape`).
- `server/constants.ts` — form ranges and values (difficulty 1–18, tempo 30–240,
  modes) plus `clamp`; the shared source of truth for server and client.
- `server/piano.ts` — the Playwright scenario that fills and submits the
  `/uploads/editSong/` form; captures the server response into `serverDetail`.
- `server/pieces.ts` — the catalogue of all My Uploads.
- `server/adaptive-notes.ts` — the MusicXML note model: events on musical time,
  streams, bar durations.
- `server/adaptive-melody.ts` — the leading melodic stream, LBDM, melodic rests.
- `server/adaptive-harmony.ts` — key, chord roots, cadences.
- `server/adaptive-structure.ts` — self-similarity, novelty, repeats, section
  graph, hypermeter (period and phase).
- `server/adaptive-navigation.ts` — the performance-order graph (repeats,
  voltas, `D.S.`, `To Coda`).
- `server/adaptive-learning.ts` — context assembly, signal informativeness,
  dynamic optimisation of Phrase, Bridge, Review, Summarize, and confidence.
- `server/adaptive-quality.ts` — musical metrics of a plan.
- `server/fixtures/phrase-ground-truth.json` — expert annotation of boundaries.
- `server/learning-adaptive-page.ts` — applies a finished Adaptive plan to
  Chopped in a single pass.
- `server/adaptive-corpus-audit.ts` — checks the algorithm against a corpus of
  real MXL files.
- `server/fingering-model.ts` — the pure ergonomic cost model (Parncutt/Jacobs)
  with the tempo correction and hand-shift term.
- `server/fingering-score.ts` — MusicXML parsing for the fingering engine:
  events, ties, slurs, pedal, tempo.
- `server/fingering-patterns.ts` — the pedagogical layer: scales, arpeggios,
  Alberti bass, five-finger cells, accompaniment figures.
- `server/fingering-motifs.ts` — repeated figures: one hand shape per figure,
  including material that recurs later.
- `server/fingering.ts` — the beam search over hand events and the public API.
- `server/fingering-xml.ts` — writing fingering back into MusicXML, in both the
  resource layout and the Piano Marvel layout.
- `server/fingering-bench.ts` / `server/fingering-audit.ts` — the two quality
  metrics.
- `server/learning-plan.ts` — the pure idempotent Whole/Chopped/Minced plan and
  strict validation of the target scheme.
- `server/learning-mode.ts`, `server/learning-page.ts` — the Playwright
  pipeline: adaptive waits, checkpoint saves, strict classification and a final
  server-side verification.
- `server/learning-cleanup.ts` — a safe reset of WARN/NO that keeps one original
  two-hand Whole as a template.
- `server/cache.ts` — the SQLite cache of the catalogue and verified statuses,
  with an algorithm version and the time of the last check.
- `server/learning-jobs.ts` / `server/learning-workers.ts` — background jobs,
  long-poll progress and the queue of independent browser lanes;
  `server/browser-task.ts` serialises only the operations that touch the single
  persistent profile.
- `server/browser.ts` — the one shared browser with a persistent profile: it is
  where the UI sign-in happens (`/api/login`, `/api/status`), and it is reused
  for uploads (the session survives restarts).
- `server/scrape.ts` / `server/capture.ts` — reverse-engineering tools (below).
- `src/App.vue` — the interface.

The form selectors (`data[Piece][...]`) and genre ids were taken from the real
form on pianomarvel.com on 2026-07-19. If Piano Marvel changes its markup, run
`bun run scrape` (genres and difficulty update automatically) or fix the
selectors in `server/piano.ts`.

### Reverse-engineering tools (optional)

These require one completed sign-in (`bun run login`). Details and a map of the
gaps are in [architecture.md](architecture.md).

```bash
bun run scrape            # re-read genres/difficulty from the form → server/genres.ts
bun run scrape --dry      # show only, write nothing
bun run capture 157779    # log the slicing tool's RPC calls to captures/rpc-157779.jsonl
```

> `captures/` is in `.gitignore` — the dumps may contain a `clientID` or `token`.

The detailed data model, the order of operations, tempo readiness and the
"Chopped without RH/LH" invariant are described in
[architecture.md](architecture.md).

## Adaptive controls in the library

- "Plan" computes Phrase, Bridge, Review and Summarize without writing anything
  to Piano Marvel; from the expanded panel you can run exactly the Adaptive plan
  you were shown.
- The row shows quality metrics, warnings and the reason for every Phrase
  boundary.
- "Refresh all" reports a single combined outcome, including job-scheduling
  errors; "Cancel queue" removes only the jobs that have not started yet.

## Reorganising the local library

An old local MuseScore library can be brought safely to the
`<artist>/<piece>/<set>` layout, starting in preview mode:

```bash
bun run server/musescore-relayout.ts
bun run server/musescore-relayout.ts --apply
```

Without `--apply` the script only prints a plan and changes nothing. With
`--apply` it moves the MXL/MID/MP3/PDF together with the `fingered` version and
re-points the exact path in SQLite. Conflicts are never overwritten.

## Documentation language

The interface and the code comments are in Russian. The documents under `docs/`
are the working design records of the project and are also in Russian; this
README and [architecture.md](architecture.md) are the English entry points.

## License

[MIT](LICENSE). The bundled grand piano samples under `public/audio/` are a
subset of the Salamander Grand Piano by Alexander Holm, licensed
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) — see
[public/audio/grand-piano/README.md](public/audio/grand-piano/README.md).
