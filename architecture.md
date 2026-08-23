# Piano Marvel — API map (for reuse)

Piano Marvel consists of two independent backends. Everything described below
was obtained by reverse-engineering the real form and SPA on 2026-07-19 (piece
"Gymnopédie No. 1", id **157779**) — anywhere I am not 100% certain is marked
explicitly as **[GAP]**.

> **Gap status (updated).** Some of the original "unknowns" were not
> fundamentally unresolvable, merely under-observed. Tools were added for those
> (see §5 "Tools") that capture the missing data from a live session instead of
> guessing:
> - **gap #7** (genre table / difficulty scale) — **closed**: `bun run scrape`
>   re-reads the form's `<select>` elements and regenerates `server/genres.ts`.
> - **gap #5** (Legacy Upload API response) — **partially closed**:
>   `server/piano.ts` now intercepts the form's own AJAX response (status plus
>   body) and returns it in `UploadResult.serverDetail`.
> - **gap #1** (body of method 162) — **closed**: the Save JSON schema is
>   confirmed, and `server/learning-reviews.ts` safely augments the page's own
>   request with review Chopped exercises, without extracting a token from the
>   browser.
> - **gap #2** (individual RPCs per action) does not block automation: Predict,
>   Split Hands, Duplicate and Delete mutate the local model, after which the
>   state is persisted by the regular Save button through method 162.
>
> The internal Predict algorithm and token refresh remain closed parts of Piano
> Marvel. For Learn Mode this is no longer a blocker: alongside resumable
> Predict there is an independent Adaptive MusicXML planner with verifiable
> musical boundaries, Bridge/Review/Summarize and a corpus audit.

---

## 1. Legacy Upload API (the score upload form)

An ordinary server-rendered form (CakePHP style), with no separate REST/JSON
API.

- **URL:** `https://pianomarvel.com/uploads/editSong/` (create) /
  `https://pianomarvel.com/uploads/editSong/{pieceId}` (edit an existing piece).
- **Method:** a plain HTML `POST`, `multipart/form-data` (because of the files),
  through a real browser session — **not** a JSON API.
- **Auth:** a cookie session in a dedicated `.browser-profile/`. Google OAuth is
  performed by hand in normal Google Chrome without Playwright: Google rejects
  automated Chromium as unsafe. After signing in, the user presses "I'm signed
  in — check": `server/browser.ts` terminates the separate process and reopens
  the same profile through Playwright with `channel: "chrome"` and without
  `--use-mock-keychain`, so that cookies can be decrypted through the system
  Keychain. A username/password login endpoint was **deliberately not reverse
  engineered** — the password never passes through the application.

### Form fields (`data[Piece][...]`)

| Field (name attribute) | Type | Required | Notes |
|---|---|---|---|
| `data[Piece][title]` | text | yes | Title |
| `data[Piece][subTitle]` | text | no | Subtitle |
| `data[Piece][composer]` | text | no | Composer |
| `data[Piece][artist]` | text | no | Performer |
| `data[Piece][copyright]` | textarea | no | |
| `data[Piece][difficulty]` | select | no | Values **1–18** (numeric) |
| `data[Piece][default_tempo]` | text/number | no | BPM, **30–240**. This carries the same meaning as "Original/Fast" in the nextgen Learn Mode, but the fields are **not synchronised automatically** — if you change the tempo in the slicing tool, this field is not updated for you (verified: 66→54 had to be corrected by a separate save of the form) |
| `data[Piece][genres][]` | multi-select | **yes** | Values are numeric ids, see the table below. The form rejects an empty selection: "At least one genre is required." The score analyser returns an empty list when no keyword matched, so `resolveGenreValues` always substitutes `DEFAULT_GENRE`, and `ensureGenreSelected` verifies the actual selection in the DOM and falls back to the form's own first option if the genre map is stale |
| `data[Piece][assessment_mode]` | select | no | `0`=Learn & Play, `1`=Play Only, `2`=Learn Only |
| `data[Piece][midi_file]` | file input | no | `.mid`/`.midi` |
| `data[Piece][xml_file]` | file input | no | `.mxl`/`.musicxml` |
| `data[Piece][audio_file][]` | file input (multiple) | no | `.mp3`/`.wav`/`.m4a` — several allowed |
| `data[Piece][pdf_file]` | file input | no | PDF sheet music |
| `data[Piece][image_file]` | file input | no | preview/cover |
| `data[Piece][visibility]` | select | no | Appeared with a form update, defaults to `0` |
| `data[Piece][users]` (`#share-user-hidden`) | text | no | The "share with users" widget (the visible field is `#share-user-text`, the message is `data[Piece][users-message]`). **An empty value must not be submitted:** the server parses it into a list containing one empty entry and rejects the form with "The following users could not be found:". `submitUploadForm` disables the widget's empty fields so they never reach the POST |

Submission goes through `form.requestSubmit()`: the markup of the visible submit
control may switch between a `button`, an `input` and a legacy icon, whereas the
form event is stable.

### Genre table (`server/genres.ts`)

```
Classical=1, Holiday=3, Christian & Gospel=5, Jazz/Blues=6,
Rock & Country=8, Pop=12, TV & Film=13, Sacred=14, Contemporary=15,
Scales & Exercises=16, Institutional=17, Methods=18, World=19, Folk=20,
New Age Piano=21, Musical=22, Video Game Music=23
```

### Local MXL/MusicXML analysis

`server/scoreAnalyzer.ts` extracts the title, creator, copyright and the first
valid tempo in the 30–240 BPM range from the score. If the MusicXML contains no
tempo, the scanner reads the first `Set Tempo` from the neighbouring MIDI file;
if there is no tempo there either, a safe default of 60 BPM is substituted for
the legacy upload. This fallback does not rewrite the source files and does not
take part in Learn Mode calculations. Genre is chosen by local rules from the
textual metadata; if there is no confident match, the field is left empty. This
is deliberately not an external network classifier, so the result should be
reviewed before uploading.

Difficulty is computed on Piano Marvel's 1–18 scale from notes per bar, the
proportion of chords, the number of voices, the frequency of short durations and
triplets, accidentals, range, bar count and the number of staves. Rare isolated
difficult elements should not inflate the estimate significantly.

**[GAP]** The genre list was captured once by hand from the form page — if Piano
Marvel adds or renames a genre, the table goes stale. It is updated only
manually (or by a script that walks the `<select>` and rescans everything —
there is no such script yet).

### Detecting success

After the Submit click the form is sent by AJAX and:

1. the URL changes to `/uploads/editSong/{id}` (awaited with `waitForURL`,
   timeout around 20s);
2. the text "saved successfully" appears on the page (a green banner).

If both conditions fail to hold within the timeout we treat it as a failure (in
the current code, without retries).

**[GAP → partially closed]** Success used to be detected purely from the DOM
(URL plus banner text), with the raw network response never read. Now
`server/piano.ts` intercepts the status and body of the AJAX response through
`page.waitForResponse(POST /uploads/editSong)` and puts them into
`UploadResult.serverDetail`; on failure it also tries to pull the inline error
text out of the page (`extractFormError`). What is still **not** formalised in a
machine-readable way is the exact JSON schema of the response and the validation
error codes ("file too large" and so on): to capture those, it is enough to
upload a deliberately broken file once and inspect `serverDetail`.

---

## 2. Nextgen Learn Mode API (slicing tool)

A modern SPA at `https://pianomarvel.com/en/nextgen/...` that talks to a
**different host** — `https://api.pianomarvel.com/` — over an RPC-like protocol
on top of HTTP.

### 2.1 Authentication

- After logging in to pianomarvel.com, a **`userInfo`** key appears in
  `localStorage`:
  ```json
  { "clientID": "...", "token": "...", "data": { /* user profile */ } }
  ```
- `clientID` plus `token` are required parameters for almost every call to
  `api.pianomarvel.com`.
- The token does not live forever: an `expiredDate` roughly 20 hours after
  `requestDate` was observed (so on the order of a day).
- **[GAP] No refresh endpoint found.** It was not verified whether the token
  renews itself while the SPA is actively used, or simply expires and requires a
  new login. A long-running automated process will need to establish this (for
  example: sign in again once a day through the same Playwright profile, given
  there is no refresh endpoint).
- **[GAP] How the API issues `clientID`/`token` at login itself (raw) was not
  reverse engineered.** This too was deliberately left alone: logging in with a
  password from code is a forbidden action; the current architecture
  (`server/browser.ts`) relies on a persistent Playwright profile and cookies
  rather than obtaining a token through a login API itself.

### 2.2 RPC protocol

- Calls go to `https://api.pianomarvel.com/?server-method-{N}` (the number N
  being the method id), with a JSON body.
- **Known methods:**
  - **`server-method-146`** — load a piece's slicing scheme. Request:
    `data.pieceId`. Response: `data.slicings[]`, one record per tab —
    `pieceSlicingType` (`W`/`C`/`MIN`), `pieceSlicingId`, `tempos[3]`,
    `tempo_titles[3]`, `exercises[]`. The page fills its client cache from this
    response; the pipeline reads the cache, not the response (see 2.3).
  - **`server-method-162`** — save the slicing state (the whole exercise list
    for one tab / `piece_slicing_id` at once). This is exactly the method
    triggered by the **Save** click in Whole/Chopped/Minced.
- **Confirmed schema of method 162:** the SPA's outer envelope carries session
  fields, and the payload lives in `data`: `piece_id`, `piece_slicing_id`,
  `piece_slicing_type`, `piece_slicing_tempos` and the full `exercises` array.
  An exercise contains `id` (`null` for a new one), `title`, measure/tick
  boundaries, `staffs`, `index` and `omit_title`.
- The code deliberately does not assemble the session envelope and does not read
  the token by hand. `server/learning-reviews.ts` intercepts the Save request
  the page has already built, modifies only `data.exercises` /
  `piece_slicing_tempos`, and lets the original request continue. This preserves
  the authorisation and the format of the current SPA version while still
  allowing exact review ranges to be added.
- **[GAP] The RPC numbers of the other actions (Delete / Split Hands /
  Duplicate / Reset Title / Add New Exercise / Predict New Exercise) have not
  been identified.** It is unclear whether each button fires its own RPC
  immediately, or whether they all merely mutate local state
  (`localStorage.slicingData` plus an in-memory store) with the real network
  call happening only once, on **Save** (through method 162 with the finished
  list). Judging by behaviour (Undo works instantly and offline; Save alone
  becomes active/pink only after some local change), the second option looks
  likely, but this has not been confirmed by logging the network per button.
  **Testable with the same `bun run capture`:** click each button and see
  whether a line appears in the `.jsonl`. If there is no network call, the
  "everything is local until Save" hypothesis is confirmed.

### 2.3 Data model (confirmed by observing the UI and the network traffic)

> **Piano Marvel incident (2026-08-06).** For a day the page stopped populating
> `localStorage.slicingData` (the key was created empty, `{}`, and sessionStorage
> and IndexedDB were empty too), and every step failed with "the slicing tool was
> not prepared". Piano Marvel restored the mirroring. Cache access has been moved
> into `server/slicing-store.ts` (`window.__pmSlicing`, installed via
> `addInitScript` before the page's own scripts) — the same key, only without
> twelve copies of JSON parsing spread across the pipeline, plus diagnostics that
> print the REAL storage keys. The variant that reads the scheme straight out of
> the `server-method-146` response (a network mirror with XHR/fetch patches)
> remains in commit `d1ed3d8` — take it from there if Piano Marvel breaks the
> mirroring again.

- `localStorage.slicingData[pieceId]` — an object with one record per tab. Each
  record has:
  - `piece_slicing_id` — a separate numeric id **per tab** (Whole, Chopped,
    Minced are three different ids for one piece).
  - `sortName` — the tab code: `"W"` = Whole, `"C"` = Chopped, `"MIN"` = Minced.
- Inside a record is an array of exercises. Observed fields and semantics
  (without a guarantee of the exact key names in the real JSON, see the gap
  above):
  - **`piece_slicing_tempos`** — an array of **up to 3** BPM values in the order
    **`[Slow, Medium, Fast]`**. If not all are filled in, the zero/unfilled
    values are **cut out** of the array rather than left as zeros (for example,
    if only Fast=100 is set, the array looks like `[100]`, not `[0, 0, 100]`).
    This matters when assembling a raw payload.
  - **`staffs`** — a boolean array; index 0 is the right hand, index 1 is the
    left hand, and any remaining indices are always `true`.
    - A whole (not hand-split) exercise: all `true`.
    - After **Split Hands** on a source exercise, **two new** records are
      created (they do not replace the original):
      - `staffs = [true, false, ...true]` with the suffix `" - RH"` on the title.
      - `staffs = [false, true, ...true]` with the suffix `" - LH"`.
      - The original (combined) exercise stays as it is.
      - Result: 1 segment → 3 records (RH, LH, combined).
  - The `title` is generated automatically following the pattern
    `"{N}. (m. {start}-{end})"`, with `" - RH"` / `" - LH"` appended after Split
    Hands. The ordinal `{N}` runs across the whole tab list, not per musical
    segment.

### 2.4 UI actions and their effects (what could only be reproduced by clicking)

- **"Predict New Exercise"** — an algorithmic/AI detector of musical phrase
  boundaries. **[GAP] The algorithm is a black box.** All that is confirmed is
  that the chunk size is **not fixed** (chunks of 5 and of 6 bars were observed
  back to back from bar 45 onwards in Gymnopédie No. 1), so it is not "split
  every N bars" but something that takes the score's real systems and phrasing
  into account. No RPC method number was found for it, so reproducing this logic
  exactly outside the UI is impossible. An alternative is already implemented:
  the Adaptive strategy builds its own deterministic plan from MusicXML,
  explains its confidence and warnings, and does not depend on a series of
  Predict calls. The detailed model is in
  [docs/adaptive-learning.md](docs/adaptive-learning.md).
- **"Duplicate Chopped"** (on the Minced tab only) — copies every exercise from
  Chopped, with their tempos, into Minced.
  - **Precondition:** the button appears and works correctly only if Minced is
    **empty** (0 records) at the moment of the click. If something is already
    there, delete everything first (or use a "replace" method that has not been
    found yet).
- **"Split Hands"** — available as a single action (through the `⋮` on a row)
  and as a **bulk** action (through "Multi-select" mode → checkboxes → the
  shared `⋮` menu at the top). The bulk form applies to every selected exercise
  at once, producing the pattern from 2.3 (RH+LH+combined) for each. In the
  production pipeline it is applied only to Whole and Minced. Chopped always
  stays two-handed.
- **The multi-select bulk menu** (the `⋮` icon next to "N Selected") contains
  `Delete`, `Split Hands`, `Duplicate` and `Reset Title`. All apply to the
  current selection.
- **"Add New Exercise"** creates a `Drag to select measures` placeholder; after
  the range is chosen and Done is pressed, an exercise with `id: null` appears
  in the Save payload. For bulk review chunks an equivalent augmentation of the
  regular payload is used, because the virtualised score does not keep every bar
  in the DOM at once.
- **Save** — one button per tab, activated (and turning pink) on any unsaved
  change, firing method 162 (see 2.2). **Undo** is a local rollback of unsaved
  state, with no network call.

### 2.5 Hazards (from first-hand experience during this run)

- Pressing **Escape** inside the slicing editor closes the **entire** editor
  (not the current menu or tooltip), and if there are unsaved changes a
  `confirm`-like system dialog appears: **"Save Changes — You have unsaved
  changes that may be lost. Do you want to save them before exiting?"**
  (Yes/No). After either answer the SPA performs a **full navigation** to the
  dashboard or another page — the tab state must be re-verified after coming
  back (do not trust what the DOM shows before a hard round-trip navigation).
- After certain bulk actions (ticking checkboxes such that the resulting
  selection becomes a contiguous range, which shows a hint like "Add (m. X-Y)")
  **the list scrolls itself to the top** — clicking blindly by coordinates in a
  batch without a screenshot between clicks has a high chance of hitting the
  wrong checkboxes. Practical conclusion: when automating with Playwright, click
  checkboxes **one at a time**, verifying state between clicks (or use
  `page.locator` on the row text rather than bare coordinates).
- The client-side scheme cache (historically `localStorage.slicingData`) may
  visually "look like" saved state after a soft reload even when nothing reached
  the server — the client cache survives a soft reload. Persistence must be
  verified with a **hard** navigation (a full `page.goto` to the slicing tool
  URL), not with `location.reload()`.

### 2.6 The implemented general Learn Mode pipeline

The pipeline is not tied to a title, a specific MXL or a fixed number of bars.
The user picks one of two Chopped strategies:

- **Adaptive** — the local MusicXML planner; one deterministic pass, explainable
  features and a strict final check.
- **Predict** — a compatible fallback through Piano Marvel's own button;
  MusicXML is not required, and the boundaries remain the site's black box.

Both strategies are reduced to the same target scheme of Whole / Chopped /
Minced. The inputs are `pieceId`, the chosen strategy and, for Adaptive, the
attached MusicXML. Duration, Fast BPM and the boundaries of a given piece are
read from its state; neither the file nor bar numbers take part in the rules.

Components:

- `server/adaptive-notes.ts` — the note model: bar events on musical time,
  `part:staff:voice` streams, durations under anacrusis and senza misura.
- `server/adaptive-melody.ts` — the leading stream, local LBDM boundaries,
  melodic rests relative to the score's own norm.
- `server/adaptive-harmony.ts` — key (Krumhansl–Kessler), chord slots per beat,
  harmonic rhythm, cadence classification.
- `server/adaptive-structure.ts` — the bar-level self-similarity matrix, Foote
  novelty, maximal literal repeats, the section graph, hypermeter (period and
  phase).
- `server/adaptive-navigation.ts` — the performance-order graph: repeats,
  voltas, `D.S.`, `D.C.`, `To Coda`; breaks in printed adjacency.
- `server/adaptive-learning.ts` — musical context assembly, signal
  informativeness, dynamic Phrase optimisation, construction of
  Bridge/Review/Summarize, and confidence.
- `server/adaptive-quality.ts` — musical quality metrics of a plan (closure,
  hypermeter, formal seams, duration spread, forced cuts, navigation breaks,
  comparison against expert annotation).
- `server/learning-adaptive-page.ts` — adds a finished Adaptive plan to Chopped
  in a single MusicXML-derived pass.
- `server/adaptive-corpus-audit.ts` — a corpus check of coverage, durations,
  seams and the three Summarize parts, plus a report of musical metrics per
  score.
- `server/learning-plan.ts` — the pure planner and the strict validator of the
  shared target scheme.
- `server/learning-page.ts` — resilient Playwright actions by role/text/class
  with Predict limits, adaptive readiness conditions and a mandatory Save.
- `server/learning-cleanup.ts` — a safe reset: it first picks the longest
  original two-handed Whole, then replaces W/C/MIN with a clean baseline. If
  there is no safe Whole, deletion never starts.
- `server/learning-reviews.ts` — adds score-derived Chopped chunks through the
  regular Save request.
- `server/learning-mode.ts` — orchestration of the chosen strategy, hard reload
  and final verification.
- `server/learning-jobs.ts` — background jobs and precise progress/error.
- `server/learning-workers.ts` — a FIFO queue with `LEARN_CONCURRENCY=3`: lane 0
  works through the persistent profile, the other lanes create separate
  BrowserContexts from its storageState. Cookies are shared at seed time while
  localStorage is isolated, so the shared `slicingData` key does not collide
  between pieces.
- `server/browser-task.ts` — a mutex for operations on the persistent profile
  only.
- `server/cache.ts` — the local SQLite source of truth for fast reads of the
  catalogue and the last verified statuses. Status records are tied to an
  algorithm version, so an incompatible old cache is never served as current.

Target state:

1. **Whole:** the original two-handed exercise plus the missing RH/LH.
2. **Chopped / Adaptive:** two-handed exercises only, organised into a
   hierarchy:
   - `Phrase` covers Whole continuously and is chosen by a joint optimiser;
   - `Bridge` covers every Phrase seam and every significant internal tempo
     transition;
   - `Review` joins 2–4 whole Phrases, prioritising a formal boundary;
   - `Summarize 1/3–3/3` — three continuous large parts, jointly optimised
     between Phrases. Shares of 18–48% are acceptable: form matters more than a
     mechanical 33%.
3. **Chopped / Predict:** Predict New Exercise is run until the end of Whole is
   covered; the base phrases are strictly two-handed as well.
4. **Minced:** created from Chopped; RH/LH are then added for every segment.
5. **Tempos:** Fast is taken from Whole, Slow=`round(Fast×0.60)`,
   Medium=`round(Fast×0.80)`, Fast=`100%`; each result is clamped to 30–240.
   For `157783`: `96 / 128 / 160` on all three tabs.

Adaptive's musical invariants:

- a boundary inside a tie or an extended tempo span is heavily penalised;
- a long gesture may be cut as an emergency measure only together with a Bridge
  and a warning, so that a Phrase does not grow to dozens of bars;
- Review and Summarize use whole Phrases only;
- every seam between adjacent Phrases is covered by a Bridge;
- the MusicXML range must match Whole exactly; an automatic bar shift is
  considered unsafe;
- confidence is computed separately for form, expressive, motor and mapping.

The full musical model, the corpus and the academic sources are described in
[docs/adaptive-learning.md](docs/adaptive-learning.md).

Tempo inputs appear before the Angular handlers do. The pipeline therefore waits
for full page readiness, then — after switching tabs — for that tab's model to
be ready, enters values through keyboard events, and lets Angular process the
blur before Save. A plain `fill()` changes the input visually but may leave
`0/0/160` or `0/0/100` on the server.

There are no fixed pauses after loading or after switching tabs: the transition
continues as soon as the active tab, the DOM and the piece scheme
(`__pmSlicing.read(pieceId)`) agree. The score itself has its own trigger — the
appearance of `.vf-stavenote` noteheads (measured on the live site: the
`.loading-wrapper` overlay disappears within seconds, while the noteheads appear
later and with a wide spread) — so the seed selection of bars starts exactly
when there is something to select. Before the selection itself, the code checks
that no foreign overlay covers the point: a closed Piano Marvel modal stays in
the DOM together with `body.modal-open` and keeps intercepting the mouse, so
`dismissErrorModal` completes on the fact of "no longer intercepting", not on
the removal of the `show` class. Predict first confirms local growth of the
model. Confirmed changes are persisted in checkpoint batches of several
fragments. If Piano Marvel shows a numeric pending row with an active Done but
has not yet materialised it in `slicingData`, the pipeline waits for the editor
state, sends the regular Save and re-reads the data from the server. That
reduces the number of `server-method-162` RPCs while preserving the target
algorithm and the final hard check.

Before every hard check the client scheme cache is reset (`__pmSlicing.reset()`,
which is `localStorage.removeItem("slicingData")`, installed by the init script
once per page rather than on every `openSlicingTool` call); server-side
exercises are untouched. This forces the SPA to re-read the remote state and
prevents an unsaved cache from being mistaken for success.

The local tool's HTTP API:

- `GET /api/pieces` — the local SQLite cache of the catalogue and statuses only;
  no browser is started and no authorisation is required;
- `POST /api/pieces/refresh` — an explicit headless refresh of the catalogue
  through the regular `/uploads/getItems`; already known statuses come from the
  cache, and the UI sends newly discovered pieces straight to a first check;
- `GET /api/pieces/{id}/learning-status` — the cached status only;
- `POST /api/pieces/{id}/learning-status` — an explicit strict headless check of
  one piece, storing the result in SQLite. The UI may call it sequentially for
  the whole library only after the "Refresh details" click;
- `POST /api/pieces/{id}/learning` — for `WARN`/`NO`, delete the previous scheme
  and rebuild it completely; for `OK`, only re-verify the result;
- `GET /api/learning-jobs/{jobId}?after={version}` — an event-driven long poll:
  progress, the current step and the exact error are returned after the job
  actually changes.

Every explicit POST command validates the stored Piano Marvel session in a
headless context by itself. `checked_at` changes on every successful check,
after a successful job, and after the control read of the actual state when a
job fails.

After a successful legacy upload the piece is added to the SQLite catalogue
immediately, and the same pipeline starts automatically if the option is enabled
and the assessment mode is not `Play Only`. A Learn Mode failure does not turn a
successful upload into an error and does not trigger a re-upload.

---

## 3. Gap summary (with status)

Legend: 🔴 open · 🟡 tool available / partial · 🟢 closed.

1. 🟢 **Method 162** — the schema is confirmed; new exercises are added by
   modifying the page's own Save request, without extracting credentials.
2. 🟡 **RPC numbers for Delete / Split Hands / Duplicate / Reset Title / Add /
   Predict** — not identified, but they do not block the pipeline: the actions
   are performed through the UI and persisted by method 162.
3. 🟡 **The "Predict New Exercise" algorithm** — still a server-side black box,
   but fully automated through the UI with a limit of 100 steps.
4. 🔴 **Token refresh without a manual login** — not found; whether the token
   renews in the background was not verified. `capture` may help spot a refresh
   request if one exists, but no dedicated endpoint is visible so far.
5. 🟡 **Legacy Upload API response/error schema** — `server/piano.ts` now
   captures the form response into `serverDetail`; a machine-readable schema of
   validation errors has not been formalised yet (capture it once with a broken
   file).
6. 🔴 **`default_tempo` (legacy) and Learn Mode BPM (nextgen) do not
   synchronise** — an architectural property of the site; when changing tempo,
   fix both places by hand.
7. 🟢 **Genre table and difficulty scale (1–18)** — closed: `bun run scrape`
   re-reads the `<select>` elements and regenerates `server/genres.ts`; the
   difficulty range is printed for comparison against `DIFFICULTY` in
   `server/constants.ts`.
8. 🟢 **Add New Exercise** — arbitrary measure ranges and the new-exercise
   payload (`id: null`) are confirmed; in production, review chunks are added
   through the regular Save envelope.

---

## 4. How to reuse this

- Everything in section 1 (Legacy Upload API) is stable, already used in
  `server/piano.ts`, and can be extended without concern (it is just an HTML
  form). Range validation (difficulty 1–18, tempo 30–240) and file existence
  checks live in `server/constants.ts` / `server/piano.ts`.
- Section 2 is implemented as a hybrid: Playwright drives the regular UI
  actions, while review Chopped chunks augment the Save request the page has
  already built. The sequence is fixed in §2.6; a re-run safely re-reads the
  server and performs only the missing steps.

---

## 5. Tools (capture the missing data from a live session)

All of these require one completed sign-in (`bun run login`; the session is
stored in `.browser-profile/`). The password never passes through the code —
only through a real window.

| Command | What it does | Which gap it closes |
|---|---|---|
| `bun run login` | Opens a window, waits for a manual sign-in, saves the session | precondition for the rest |
| `bun run scrape` | Reads `<option>` elements from the form's `<select>`s, regenerates `server/genres.ts`, prints the difficulty range (`--dry` shows only) | #7 |
| `bun run capture <pieceId>` | Monkey-patches `fetch`/`XHR` on the slicing tool before the bundle loads; writes the raw body, headers and response of every call to `api.pianomarvel.com` into `captures/rpc-<id>.jsonl` | #1, #2 (and possibly #4) |
| `bun run dev` → upload through the UI | `server/piano.ts` captures the form response into `serverDetail` | #5 |

`captures/` is in `.gitignore` — the raw dumps may contain a `clientID` or
`token` and must not be committed.
