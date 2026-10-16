# HANDOFF — session state log

> Update at the end of every session. Keep under one page. Newest entry on top.

## Session 1 — Milestone 1: scaffold + Maia-3 helper server ✅

**What works**
- Repo scaffold: `git init`, `server/`, `extension/` (README placeholder only), `docs/`, `test/` (README placeholder), `.gitignore`.
- `server/.venv` (Python 3.12.14 via `uv`; torch 2.14.1+cpu, maia3 0.1.0 pinned @`1e13597`, fastapi 0.143.3, uvicorn 0.54, python-chess 1.11.2, pytest, httpx). Setup commands: `server/README.md`.
- `server/maia_engine.py` — loads Maia3-5M once; `predict(fen, moves=None, elo_self=2400, elo_oppo=2400, top_k=3)`; legal-masked softmax, argmax top-1 (temperature-0 path), `--use-uci-history` reconstruction; ~10–15 ms/position on CPU.
- `server/app.py` — FastAPI on `127.0.0.1:8765`: `GET /health`, `POST /analyze`; dev CORS for localhost + `chrome-extension://` origins.
- Checkpoint cached at `~/.cache/huggingface` (`UofTCSSLab/Maia3-5M`, ~20 MB; first load downloads it).

**Run**
```bash
cd server
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:8765/analyze -H 'Content-Type: application/json' \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

**Test**
```bash
cd server && .venv/bin/python -m pytest tests -q     # 52 passed (~3 s)
.venv/bin/python tests/golden_report.py              # full table: docs/golden-report-m1.txt
```

**Observed outputs** (full detail incl. top-5 + golden table: `docs/golden-report-m1.txt`)
- `/analyze` startpos: e2e4 0.4649 · d2d4 0.3390 · g1f3 0.0818; wdl win 0.476 / draw 0.068 / loss 0.456; 13.8 ms.
- History `{"moves":["e2e4","e7e5"]}` → Nf3 0.7835 · Nc3 0.0826 · f4 0.0504.
- Golden vs real `maia3-uci` subprocess (temperature 0, Elo 2400, `--use-uci-history`): **6/6 positions match top-1 AND top-3 ordering** — startpos→e2e4, castling→e1g1, promotion→b7b8q, endgame→e1e2, middlegame→c1g5, history(1.e4 e5)→g1f3.
- WDL perspective check: two probes where the side to move is up a queen both return win≈0.98 ⇒ value head is side-to-move perspective (as documented in `maia3/uci.py`).
- Errors: bad FEN → 400 `{"detail":"invalid FEN: ..."}`, illegal history move → 400, out-of-range params → 422.

**Known issues / notes**
- First-ever load prints an unauthenticated-HF-hub warning; harmless. Pre-fetch with `.venv/bin/maia3-cache --model maia3-5m`.
- `/analyze` `wdl` is the value head for the *current* position (side-to-move perspective), not the per-candidate WDL printed on the CLI's MultiPV lines (different quantity; see `server/README.md`).
- No clock/time info is fed to the model (matches `maia3-uci` defaults; the 5M checkpoint uses `include_time_info=False`).
- `top_k` clamped 1..20 (Maia-3 MultiPV cap); Elo clamped 0..5000 by the model.

**Next — Milestone 2**: extension skeleton (MV3) + capture-source interface + browser-tab capture + offline fixtures in `test/` (screenshots + optional DOM ground truth). Contract is frozen: `POST /analyze {fen, moves?, elo_self?, elo_oppo?, top_k?} → {moves[{uci,san,prob}], wdl{win,draw,loss}, model, elapsed_ms}`.
