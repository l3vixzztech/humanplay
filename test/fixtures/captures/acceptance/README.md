# Acceptance evidence (M9 capstone)

`test/tools/acceptance-proof.mjs` runs one end-to-end pass over the whole
product in Chrome for Testing. It is run twice, because each mode proves a
different half of the story:

| Folder | Mode | What it proves |
|---|---|---|
| `stub/` | `--stub` | the full pipeline against the fixture server with the canned bodies **recorded from the real Maia server** (`canned-acceptance.json`, top level): adapter, 14-ply replay, overlay endpoints, TTS speaks + dedupe, premove criteria, commentary per ply, **rematch reset**, the **offline UX + 503 retry + auto-recovery** (`/debug` modes), the **104-ply soak** |
| `real/` | `--real` | the same replay/soak/rematch against the **real Maia server** with every user-turn suggestion cross-checked against real `curl /analyze`; plus the best-effort **real chess.com page** segment (`--real-page`) |

Each folder contains its own `acceptance-proof.json` (the machine-readable
summary: per-ply records, spot-checks, geometry errors, speak calls, cache
sizes, console logs) and the screenshots taken during that run
(`01-adapter-startpos.png` … `06-real-chesscom-arrow.png`).

The soak is deliberately **silent** (TTS is switched off before it): 100+
spoken synthetic knight shuffles would flood the speech backend, and the
dedupe-store bound is covered by `tts-unit.mjs` plus the rematch-reset check.
The soak's canned bodies are deterministic synthetic ones — it asserts
leak-freedom, not fact correctness.

Not asserted in a headless run: long-run **memory** (use a DevTools memory
profile over a real session).
