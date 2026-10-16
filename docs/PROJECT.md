# humanplay — Project

Human-like chess move assistant: a Chrome MV3 extension that reads the chessboard
off the screen of **any** chess website and asks a **local** Maia-3 helper server
for the move a strong human (~2400 Elo) would play. Not Stockfish, not any top
engine — the point is to play like (and be predicted by) a strong human.

## Architecture

```
┌───────────────────────────────┐        ┌──────────────────────────────────────┐
│ Chrome MV3 extension          │        │ Local Python helper server           │
│                               │  HTTP  │ 127.0.0.1:8765 (FastAPI)             │
│ capture-source interface      │  JSON  │                                      │
│  └─ browser-tab source (now)  │ ─────► │  POST /analyze {fen, moves?, ...}    │
│  └─ desktop source (later)    │        │        │                             │
│ board locator (M3)            │        │        ▼                             │
│ piece classifier -> FEN (M4)  │        │  maia_engine.py                      │
│ game tracker (M5)             │        │   └─ Maia3-5M (torch, CPU)           │
│ UI: arrow + panel (M7)        │ ◄───── │        AGPL-3.0, separate venv       │
│ TTS: chrome.tts (M8)          │        │ GET /health                          │
└───────────────────────────────┘        └──────────────────────────────────────┘
        pixels only                         separate process / venv boundary
```

## Locked decisions

- **Scope**: Chrome extension, browser tabs only. Desktop-app capture is
  **out of scope for now**, but the capture layer must be an abstraction
  (*capture-source interface*) so it can be added later without changes
  downstream.
- **Position recognition is pixel-based** (screenshot → board → FEN) so it works
  on any site. DOM scraping is allowed only as optional test ground-truth on
  specific sites, never as a runtime dependency.
- **Model**: Maia-3 5M params — repo <https://github.com/CSSLab/maia3>, weights
  `UofTCSSLab/Maia3-5M` on Hugging Face. **AGPL-3.0**: it runs as a separate
  local process/venv; its code is never copied into the extension.
- **Server**: FastAPI on `127.0.0.1:8765`; the extension talks to it over HTTP.
- **Default Elo**: self 2400, opponent 2400 ("strong human" preset), adjustable
  0–5000 (Maia-3's Elo range).
- **UI** (later milestones): arrow overlay on the board + side panel with top-3
  moves and their probabilities; TTS via `chrome.tts` (Piper-ready interface)
  announcing "just the move".
- **Fair play**: the user accepts the ban risk for live play. We do **not**
  build any anti-detection features.
- **No Stockfish / top engines anywhere** in this project.

## Roadmap

| # | Milestone | Content | Status |
|---|-----------|---------|--------|
| 1 | Scaffold + Maia-3 helper server | repo scaffold, docs, venv, `maia_engine.predict`, FastAPI `/analyze` + `/health`, tests incl. `maia3-uci` golden check | ✅ done |
| 2 | Extension skeleton + tab capture + offline fixtures | MV3 manifest, capture-source interface, browser-tab capture, record fixtures into `test/` | ⬜ |
| 3 | Board locator | find the 8×8 board in the screenshot, site-agnostic | ⬜ |
| 4 | Piece classifier → FEN | pixels → piece placement → FEN | ⬜ |
| 5 | Game tracker | legal-move matching, FEN + move history, orientation, side-to-move | ⬜ |
| 6 | End-to-end wiring | captured frame → server `/analyze` → in-extension result | ⬜ |
| 7 | Arrow overlay | draw best-move arrow on the board + side panel top-3 | ⬜ |
| 8 | TTS | `chrome.tts` announcements (Piper-ready interface), "just the move" | ⬜ |
| 9 | Continuous mode + polish + packaging | auto-refresh loop, UX, store-ready packaging | ⬜ |

## Repository layout

```
server/     FastAPI helper + Maia-3 engine wrapper + tests  (this repo's engine lives here)
extension/  Chrome MV3 extension (placeholder; Milestone 2+)
docs/       PROJECT.md (this file), HANDOFF.md (state log)
test/       offline fixtures shared across milestones (placeholder)
```

## Key interfaces

- `POST http://127.0.0.1:8765/analyze`
  body `{fen, moves?, elo_self?, elo_oppo?, top_k?}` →
  `{moves: [{uci, san, prob}], wdl: {win, draw, loss}, model, elapsed_ms}`.
  `wdl` is from the **side-to-move** perspective of the analyzed position.
- `GET /health` → `{status, model}`.

Details, semantics (history planes, temperature, WDL perspective) and exact
commands: `server/README.md`.

## Licensing / boundaries

- `server/` imports the AGPL-3.0 `maia3` package (installed from GitHub into
  `server/.venv`); no maia3 source is vendored or copied.
- The extension must never contain maia3 code or any code from `server/`; it is
  a clean-room HTTP client. This keeps the AGPL boundary at the process level.
