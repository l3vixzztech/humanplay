# humanplay — Maia-3 helper server

Local FastAPI helper that wraps the **Maia-3 5M** human-move model (CSSLab, U of T)
and answers the extension's requests over HTTP on `127.0.0.1:8765`:
`GET /health`, `POST /analyze` (top-k human moves + WDL), `POST /premove` (M7 —
the premove planner: one safe queued reply, or an honest null) and `POST /explain`
(M8 — the live-commentary facts for one played move: rules flags, material, the
mover's own distribution, the mover's WDL before/after, the ECO opening name and
a documented probability band).

Maia-3 predicts what a strong human (~2400 Elo) would play — this is **not**
Stockfish and not a top engine. AGPL-3.0: Maia-3 lives in this separate
process/venv; its code is never copied into the extension.

## Setup (already done in this repo; reproducible from scratch)

The one-command path (idempotent — safe to re-run):

```bash
scripts/setup-server.sh    # venv + CPU torch + maia3 (+ pre-fetch the checkpoint)
scripts/run-server.sh      # serve 127.0.0.1:8765
```

The same steps by hand — requires `uv` and Python 3.12 (system Python 3.14 is
intentionally unused):

```bash
cd server
uv venv --python 3.12

# CPU-only PyTorch wheel (avoids the multi-GB CUDA download):
uv pip install torch --index-url https://download.pytorch.org/whl/cpu

# Maia-3 (pinned to the reviewed upstream commit) + server/test deps:
uv pip install "maia3 @ git+https://github.com/CSSLab/maia3@1e13597c42d4858b7cfd7cfdae01e297263364b2" \
    fastapi "uvicorn[standard]" python-chess pytest httpx
```

The Maia3-5M checkpoint (~20 MB) is downloaded from Hugging Face
(`UofTCSSLab/Maia3-5M`) on the first model load and cached in `~/.cache/huggingface`.
Pre-fetch it without starting the server:

```bash
.venv/bin/maia3-cache --model maia3-5m
```

## Run

```bash
cd server
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
```

First start loads/downloads the checkpoint at startup (warm-up). If the warm-up
fails, the server still starts and retries the load on the first `/analyze`.

Alternative (same thing): `.venv/bin/python app.py`.

## API

### `GET /health`

```bash
curl -s http://127.0.0.1:8765/health
# {"status":"ok","model":"maia3-5m","version":"1.0.0","uptime_s":11.047}
```

`status` is `"ok"` once the model is loaded, `"not_loaded"` otherwise.
`version` and `uptime_s` were added in M9 (additive): the extension's panel
shows the version in its server chip and uses repeated `/health` polls for its
offline auto-recovery.

### `POST /analyze`

Request body:

| field | type | default | notes |
|---|---|---|---|
| `fen` | string | required | base position FEN |
| `moves` | string[] | `null` | optional UCI moves applied to `fen` (history) |
| `elo_self` | int 0–5000 | `2400` | Elo of the side to move |
| `elo_oppo` | int 0–5000 | `2400` | Elo of the opponent |
| `top_k` | int 1–20 | `3` | number of candidate moves |

Response: `{moves: [{uci, san, prob}], wdl: {win, draw, loss}, model, elapsed_ms}`.

```bash
curl -s http://127.0.0.1:8765/analyze \
  -H 'Content-Type: application/json' \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

```json
{
  "moves": [
    {"uci": "e2e4", "san": "e4", "prob": 0.464967},
    {"uci": "d2d4", "san": "d4", "prob": 0.338979},
    {"uci": "g1f3", "san": "Nf3", "prob": 0.081816}
  ],
  "wdl": {"win": 0.476428, "draw": 0.067642, "loss": 0.45593},
  "model": "maia3-5m",
  "elapsed_ms": 11.4
}
```

With move history (reconstructs the model's history planes; the resolved
position after `1.e4 e5` is analysed):

```bash
curl -s http://127.0.0.1:8765/analyze \
  -H 'Content-Type: application/json' \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
       "moves":["e2e4","e7e5"],"elo_self":2400,"elo_oppo":2400,"top_k":3}'
```

Errors: `400` for invalid FEN / illegal history move, `422` for out-of-range
parameters, `503` if the model cannot be loaded.

### `POST /premove` (M7)

The premove planner: while the **opponent** is to move, does exactly ONE of our
replies hold up as a premove? It is same-Maia end to end and its honest value is
*refusing mispredicted premoves* — full criteria formulas and semantics:
`premove_engine.py` (documented in the module docstring) and docs/PROJECT.md.

Request body (numeric knobs are **clamped**, not rejected):

| field | type | default | notes |
|---|---|---|---|
| `fen` | string | required | base position FEN (opponent to move) |
| `moves` | string[] | `null` | optional UCI history applied to `fen` (same as `/analyze`) |
| `elo_self` | int | `2400` | **you** — used for the reply predictions; clamped 0–5000 |
| `elo_oppo` | int | `2400` | the **opponent** — used for their candidate distribution; clamped 0–5000 |
| `top_n` | int | `5` | `mode="top"`: their most likely moves considered; clamped 1–12 |
| `min_safety` | float | `0.90` | required safe share of their considered mass; clamped 0.5–1.0 |
| `mode` | `"top"`/`"all"` | `"top"` | `"all"` sweeps every legal opponent move (slower) |

The `min_response_prob` floor (default 0.15) is a **server constant**, not a
request field, so a client cannot lower it; tests call `plan_premove()` directly
to override it.

Response:

```jsonc
{
  "fen": "rnbqkb1r/pp1p1ppp/4pn2/2pP4/2P5/2N5/PP2PPPP/R1BQKBNR b KQkq - 1 4",
  "side_to_move": "black",                       // the opponent
  "opponent": [{"uci": "e6d5", "san": "exd5", "prob": 0.963476}, …],
  "recommended": {                               // null when nothing is safe
    "uci": "c4d5", "san": "cxd5",
    "criterion": "safe_vs_all",                  // forced | safe_vs_all | robust
    "safety": 1.0, "min_response_prob": 0.983822,
    "detail": "1/5 considered replies are met by cxd5 (safe mass 96%); …"
  },
  "candidates": [{"uci": "c4d5", "san": "cxd5", "safe_mass": 0.963476,
                  "guard_mass": 0.036524, "min_response_prob": 0.983822,
                  "verdict": "recommended", "why": "safety 100% >= 90%; …"}],
  "excluded": [],                                // terminal replies (mate/stalemate)
  "reason": null,                                // why there is no recommendation
  "params": {"elo_self": 2400, "elo_oppo": 2400, "top_n": 5, "min_safety": 0.9,
             "min_response_prob": 0.15, "mode": "top"},
  "timings_ms": {"root": 15.05, "responses": 50.99, "total": 69.14},
  "model": "maia3-5m", "elapsed_ms": 69.14
}
```

```bash
curl -s http://127.0.0.1:8765/premove -H 'Content-Type: application/json' \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
       "moves":["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3"]}'
# -> recommended cxd5 (safe_vs_all): their exd5 (96.3%) is our take-back,
#    every other considered move cannot fire the premove (guard)
```

Timings on this machine (CPU, mode defaults): `mode="top"` ≈ 90 ms engine
(target ≤ 300 ms); `mode="all"` 0.45–0.8 s for 20–31 legal moves (target ≤ 1.5 s).
`/analyze` is **untouched** by M7 (the planner adds `move_probabilities()` and
reuses `predict`).

### `POST /explain` (M8)

The live-commentary fact engine: explains the **last ply** of `moves` from the
rules (python-chess) and the mover's own Maia distribution. It never evaluates
the move — the classification is a probability band, not a judgement. Full
semantics + the documented thresholds: `explain_engine.py` and docs/PROJECT.md.

Request body (`elo_*` are **clamped** to Maia's 0–5000, like `/premove`):

| field | type | default | notes |
|---|---|---|---|
| `fen` | string | required | base position FEN |
| `moves` | string[] | required, ≥ 1 | UCI history; the **LAST** element is the move to explain (applied to `fen` like `/analyze`) |
| `elo_self` | int | `2400` | Elo of the mover (the side to move *before* the move); clamped |
| `elo_oppo` | int | `2400` | Elo of the other player; clamped |

Response (abridged; `flags` adds the M8 `recapture` flag, `wdl` is from the
**mover's** perspective):

```jsonc
{
  "move": {"san": "Qxf6", "uci": "d8f6", "by": "black", "ply": 14, "moveNumber": 7},
  "flags": {"capture": true, "check": false, "mate": false, "castle": null,
            "promotion": null, "enPassant": false, "recapture": true},
  "material": {"delta": 3, "captured": {"piece": "bishop", "square": "f6", "value": 3}},
  "maia": {"playedProb": 0.992488, "rank": 1, "totalLegal": 33,
           "top": [{"uci": "d8f6", "san": "Qxf6", "prob": 0.992488}, …],
           "moverElo": 2400},
  "wdl": {"before": {"win": 0.456494, "draw": 0.069125, "loss": 0.474381},
          "after":  {"win": 0.540358, "draw": 0.073429, "loss": 0.386213}},
  "opening": {"eco": "C50", "name": "Italian Game: Giuoco Piano"},
  "classification": "mainline",          // mainline (rank 1) | p>=10% common | 3-10% uncommon | <3% rare
  "model": "maia3-5m",
  "elapsed_ms": 29.71
}
```

```bash
curl -s http://127.0.0.1:8765/explain -H 'Content-Type: application/json' \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
       "moves":["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5","e1g1"]}'
# -> 4.O-O: castle kingside, common (22.4%), "Italian Game: Giuoco Piano"
```

Errors: `400` for invalid FEN / illegal or unparseable history moves / an empty
`moves` list (engine level); a missing or shape-broken `moves` list is `422`
(pydantic). Timings: two Maia forward passes ~20–70 ms/article on this machine
(target ≤ 100 ms). The ECO table is bundled under
`server/data/openings_eco.json` (lichess chess-openings, **CC0-1.0**; provenance
+ regeneration: `server/data/README.md`, `server/tools/generate_openings.py`)
and `opening` is always `null` when the base FEN is not the standard start
position (the pre-base moves are unknowable). `/analyze` and `/premove` are
**untouched** by M8 (`predict` was not modified).

## Semantics (mirrors `maia3-uci`, the upstream reference)

- **`fen` is the base position.** `moves` are applied to it, exactly like UCI's
  `position fen <fen> moves ...`; the **resulting** position is analysed.
- **History planes**: with `moves`, the model input is built like
  `maia3-uci --use-uci-history` — history deque `[base, after m1, ...]` (newest
  last, capped at the model's `history=8`, missing slots left-padded with the
  earliest available position). Without `moves`, the no-history default is used:
  the current position is repeated into all history slots
  (`maia3.dataset.get_historical_tokens`).
- **Probabilities**: softmax at temperature 1 over **legal moves only** (illegal
  vocabulary indices are masked to −inf), matching the MultiPV probabilities
  printed by `maia3-uci`. The top-1 move is the argmax — the deterministic
  temperature-0 path (`--temperature 0`). Per-position probability is the
  human-move policy probability, not a search evaluation.
- **`wdl`** (win/draw/loss) comes from Maia-3's 3-class value head. Per
  `maia3/uci.py`, the value labels are `[loss, draw, win]` in the **side-to-move's
  perspective**, and we report it in the same perspective (verified empirically in
  `tests/test_predict.py::test_wdl_is_side_to_move_perspective`). It is a
  human-game outcome prediction for the side to move, not a Stockfish score.
  For finished games (`moves`/`fen` already terminal) the model is not called:
  `moves` is `[]` and the WDL is decided by the rules (mate/stalemate).
- The endpoint is **stateless**; send the history with every request.

## Tests

```bash
cd server
.venv/bin/python -m pytest tests -q            # full suite (~6 s on this machine, 106 tests)
.venv/bin/python tests/golden_report.py        # Markdown table: predict() vs real maia3-uci
```

- `tests/test_predict.py` — startpos + castling + promotion + endgame + middlegame,
  probability invariants (legal-only softmax, sums ≈ 1), history reconstruction,
  WDL perspective, error handling.
- `tests/test_api.py` — `/health`, `/analyze` contract, validation errors, CORS.
- `tests/test_premove.py` (M7) — the criteria engine with hand-verified
  expectations (forced recapture, guard recapture, strict null, safe-vs-all
  endgame, opponent-mate exclusion, the response floor) + the `/premove`
  contract (clamps, 400/422, shape, mode "all", determinism, perf targets).
- `tests/test_explain.py` (M8) — recorded model facts + hand-checked rules for
  the opening move, capture, recapture, both castlings, promotion + check, a
  plain check, mate, en passant, a rare rank>1 move (Maia's pick surfaced),
  black-to-move parity, a stalemate after; the documented bands, the ECO lookup,
  the contract 400s/422s, Elo clamps, determinism and the perf target.
- `tests/test_golden_uci.py` — runs the real **`maia3-uci` CLI as a subprocess**
  (temperature 0, Elo 2400, `--use-uci-history`) on the same positions and
  asserts the top-1 and top-3 ordering match our in-process `predict()`.

## Configuration (environment variables)

| variable | default | meaning |
|---|---|---|
| `HUMANPLAY_MODEL` | `maia3-5m` | Maia-3 alias (`maia3-5m`, `maia3-23m`, `maia3-79m`, `maia3-3m-ablation`) |
| `HUMANPLAY_DEVICE` | `cpu` | torch device (`cpu`; the machine has no CUDA) |
| `HUMANPLAY_HF_CACHE_DIR` | HF default | optional custom Hugging Face cache dir |

## Layout

```
server/
  app.py              FastAPI layer (HTTP contract: /health, /analyze, /premove, /explain)
  maia_engine.py      Maia-3 wrapper: load once, predict(fen, moves, elo_self, elo_oppo, top_k)
                      + move_probabilities() (full legal-move softmax, M7)
  premove_engine.py   M7 criteria engine: plan_premove() (documented formulas)
  explain_engine.py   M8 commentary facts: explain_move() (rules flags + Maia + ECO bands)
  data/               openings_eco.json (lichess chess-openings, CC0-1.0) + README.md
  tools/              generate_openings.py (regenerates data/openings_eco.json)
  requirements.txt    direct dependencies (torch via CPU index, see above)
  tests/              pytest suite + maia3-uci golden harness
```
