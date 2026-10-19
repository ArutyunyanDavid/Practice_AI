# PracticeAI

PracticeAI is a local music-practice web app built with React, TypeScript, Tailwind CSS, Express, OpenSheetMusicDisplay (OSMD), and the official OpenAI Node.js SDK. It opens Franz Liszt’s **Transcendental Étude No. 2 (Molto Vivace)** automatically while preserving the existing score library and conversion pipeline.

The source score remains read-only. OpenAI chooses two measure-specific musical transformations, and the backend turns those constrained plans into new, validated one-measure MusicXML practice excerpts. It never asks the model to write raw XML and never changes the source score.

## What works

- Discovers `.mscz`, `.mscx`, `.musicxml`, `.xml`, and `.mxl` files recursively inside `scores/`
- Converts native MuseScore files to MusicXML on demand and caches the validated result
- Renders complete multi-staff scores with OSMD, page navigation, scrolling, and zoom
- Selects exactly one source measure across every piano staff; selecting another replaces it and selecting it again toggles it off
- Clears visual selection on score whitespace/outside clicks without clearing prior AI output
- Extracts trusted, server-side MusicXML facts for the selected measure, including ordered notes, pitches, durations, rests, voices, staves, chords, tuplets, articulations, ornaments, directions, dynamics, tempo, and inherited score context
- Sends only that selected-measure data to OpenAI through the Express backend and the Responses API
- Returns one technical analysis and exactly two practice exercises, each with a short title, exactly two simple explanatory sentences, and playable musical notation
- Generates MusicXML deterministically on the Express backend, rejects invalid or unsafe plans atomically, and renders both exercises with OSMD
- Applies the expanded piano-practice guide to octaves, chord jumps, scales and chromatic runs, arpeggios, single-note leaps, repetitions, double notes, verified ornaments, polyrhythms, and melody/accompaniment textures
- Validates the AI-selected technique and its two allowed methods, rejects invented guided pitches or registers, and retains the general AI workflow when no named technique is supported
- Keeps the previous result visible during a new request, replaces it only after the newest request succeeds, and preserves it if that request fails
- Coalesces duplicate requests, rate-limits AI endpoints, handles upstream timeouts/rate limits safely, and never sends the API key to browser code
- Uses an approximately 60/40 desktop split between the score viewer and Practice Assistant, with a compact mobile overlay

## Requirements

- [Node.js](https://nodejs.org/) 20.19 or newer (Node 22.12+ is also supported)
- npm
- [MuseScore Studio 4](https://musescore.org/en/download) for `.mscz` and `.mscx` files
- An OpenAI API key for AI connection tests and measure analysis

Plain `.musicxml`, `.xml`, and `.mxl` files do not require MuseScore Studio. The score viewer and library still work when OpenAI is not configured; the Practice Assistant will show **Not Configured**.

## Add the OpenAI API key

Create the private project-root `.env` file from the safe template after cloning:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env`. Open that new `.env` file and paste the key immediately after `OPENAI_API_KEY=`:

```dotenv
OPENAI_API_KEY=sk-your-real-key-here
OPENAI_MODEL=gpt-6-astra
```

Do not add quotes or a `VITE_` prefix. `.env` is ignored by Git, is loaded only by the Express process, and must never be committed or pasted into frontend source. `.env.example` is the safe, keyless template.

Restart the server after editing `.env`, then click **Test AI Connection** in the Practice Assistant. The displayed states are **Connected**, **Not Configured**, and **Connection Failed**. Measure analysis uses `gpt-6-astra` with maximum reasoning effort; the connection test itself uses a low-cost probe before a full analysis request exercises the maximum-quality path.

Maximum-reasoning analysis can take several minutes. The app keeps the previous result visible while it waits and allows up to ten minutes for a difficult measure to complete.

## Start the app

From the project directory:

```powershell
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Express API runs on port `8787` during development.

The featured score is `scores/liszt-transcendental-etude-no-2-molto-vivace.mscz`. It is converted and cached automatically the first time it is opened.

## Use the Practice Assistant

1. Click a rendered measure. The entire source measure is selected across the piano grand staff.
2. Click **Analyze Measure**. Only explicit button clicks start an AI request.
3. The visual selection may be cleared while the request runs; the captured measure is still analyzed.
4. Read the analysis, exactly two explanatory sentences per exercise, and both engraved notation excerpts in the fixed Practice Assistant result area.
5. Select a different measure and click **Analyze Measure** again. The old result remains while loading and is replaced only when the new result succeeds.

The backend uses the zero-based OSMD source-measure index for identity and derives the printed label from backend-owned MusicXML. This avoids ambiguity with pickups, repeated/non-numeric printed numbers, and multi-staff notation.

## Expanded Piano Practice Guide

The expanded teaching reference remains the source for the non-octave technique rules in `Practice_Rules/piano-practice-rules.json`. Its previous octave instructions have been replaced by the safely inspected `Octaves_Exercises.docx`, which is converted into the authoritative `Practice_Rules/octave-practice-rules.json`. Both DOCX files are reference data only, remain excluded from Git, and are never parsed during an API request.

Both validated JSON rule files load once when the backend starts. Together they contain ten technique families:

1. Octaves
2. Chord jumps
3. Scales and chromatic runs
4. Arpeggios and broken chords
5. Large single-note leaps
6. Repeated notes and chords
7. Double notes
8. Verified trills and ornaments
9. Hands together and polyrhythms
10. Melody over accompaniment

OpenAI identifies the dominant difficulty from the selected measure and returns the exact rule method identifiers with its two notation plans. The backend verifies that exercise one and exercise two use an allowed pair for that technique, rejects any guided pitch spelling or register absent from the source measure, generates MusicXML itself, validates it, and only then sends both scores to OSMD. If the evidence does not support one of the ten named techniques, the existing general analysis path remains available.

Octaves retain stricter backend handling. The new octave guide provides separate outer-finger and finger-one lines, both dotted-rhythm directions, expanding five-note patterns, scale-like octave patterns with alternating accents, and progressive groups with rests. The backend selects exactly two applicable methods from the JSON policy, uses finger 5 on white-key outer notes and finger 4 on black-key outer notes, follows the source key signature, generates the MusicXML, and validates it before OSMD renders either exercise.

## MuseScore Studio executable

The server checks `MUSESCORE_PATH`, then the system `PATH`, then these common locations:

- Windows: `C:\Program Files\MuseScore 4\bin\MuseScore4.exe`
- macOS: `/Applications/MuseScore 4.app/Contents/MacOS/mscore`
- Linux: `mscore`, `musescore`, or `mscore4portable` on `PATH`

If MuseScore is installed elsewhere, add its absolute path to `.env`, for example:

```dotenv
MUSESCORE_PATH=D:\Apps\MuseScore 4\bin\MuseScore4.exe
```

## Score discovery and conversion

The backend discovers every supported file placed in `scores/`, including files in subfolders. The current interface keeps its existing featured-Liszt presentation, while the server-side library continues to support all discovered scores.

Native MuseScore files are converted only when opened:

1. The server takes a stable, read-only snapshot of the original.
2. MuseScore runs in an isolated scratch directory.
3. The output is validated as MusicXML.
4. The result is stored atomically under `.cache/scores/`.

The cache key includes the source bytes and MuseScore executable fingerprint. Editing a score or upgrading MuseScore therefore creates a new cache entry. Compressed `.mxl` files are unpacked according to `META-INF/container.xml`, with archive paths and expanded sizes validated.

## Production build

```powershell
npm run build
npm start
```

The production server hosts the API and built React app at [http://localhost:8787](http://localhost:8787).

Environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Private server-side OpenAI API key | Required for AI features |
| `OPENAI_MODEL` | Responses API model used for analysis | `gpt-6-astra` |
| `MUSESCORE_PATH` | Absolute MuseScore Studio executable path | Auto-detected |
| `SCORES_DIR` | Score library directory | `<project>/scores` |
| `SCORE_CACHE_DIR` | Converted MusicXML cache | `<project>/.cache/scores` |
| `PORT` | Backend/production port | `8787` |

When changing `PORT` for development, set it before starting both Vite and Express; the Vite proxy reads only `PORT` and does not load backend secrets.

## Verification

```powershell
npm test                 # XML extraction, all expanded guide rules, exercise generation/validation, API security, and error-handling tests
npm run build            # Frontend and backend TypeScript plus production bundle
npm run test:conversion  # Real MSCZ -> MusicXML conversion/cache verification
npm run test:ui          # Real-browser layout, OSMD exercise rendering, persistence, and request-race checks
```

`test:conversion` requires MuseScore Studio. `test:ui` expects `npm run dev` to be running and uses mocked OpenAI HTTP responses, so it does not need a real key or spend API credits. Chrome is used by default on Windows; set `BROWSER_PATH` to use another Chromium-family browser.

## API endpoints

- `GET /api/health`
- `GET /api/scores`
- `GET /api/scores/:id/content`
- `GET /api/ai/status`
- `POST /api/ai/test`
- `POST /api/scores/:scoreId/measures/:measureIndex/analyze`

The analysis endpoint accepts only a score ID, source-measure index, and optional request metadata. It reloads the score on the backend, validates the reference, extracts that measure, and calls OpenAI. Raw API keys and full-score MusicXML are never included in the AI request.

## Project layout

```text
scores/              Source scores (never modified)
server/              Express API, OpenAI service, MusicXML extraction/conversion
src/                 React interface and OSMD viewer
scripts/             Browser and MuseScore integration checks
tests/               Automated backend and AI contract tests
Practice_Rules/      Startup-loaded structured JSON teaching rules
.cache/scores/       Generated conversion cache (ignored by Git)
```
