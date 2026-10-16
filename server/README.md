# humanplay — Maia-3 helper server

Local FastAPI helper that wraps the **Maia-3 5M** human-move model (CSSLab, U of T)
and answers the extension's move requests over HTTP on `127.0.0.1:8765`.

Maia-3 predicts what a strong human (~2400 Elo) would play — this is **not**
Stockfish and not a top engine. AGPL-3.0: Maia-3 lives in this separate
process/venv; its code is never copied into the extension.

## Setup (already done in this repo; reproducible from scratch)

Requires `uv` and Python 3.12 (system Python 3.14 is intentionally unused).

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
# {"status":"ok","model":"maia3-5m"}
```

`status` is `"ok"` once the model is loaded, `"not_loaded"` otherwise.

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
.venv/bin/python -m pytest tests -q            # full suite (~3 s on this machine)
.venv/bin/python tests/golden_report.py        # Markdown table: predict() vs real maia3-uci
```

- `tests/test_predict.py` — startpos + castling + promotion + endgame + middlegame,
  probability invariants (legal-only softmax, sums ≈ 1), history reconstruction,
  WDL perspective, error handling.
- `tests/test_api.py` — `/health`, `/analyze` contract, validation errors, CORS.
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
  app.py              FastAPI layer (HTTP contract)
  maia_engine.py      Maia-3 wrapper: load once, predict(fen, moves, elo_self, elo_oppo, top_k)
  requirements.txt    direct dependencies (torch via CPU index, see above)
  tests/              pytest suite + maia3-uci golden harness
```
