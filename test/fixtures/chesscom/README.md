# test/fixtures/chesscom — offline chess.com DOM fixtures

Replicas of the **real** chess.com game-page DOM, used by
`test/tools/adapter-proof.mjs` to prove the content-script adapter
(`extension/src/content/chesscom-adapter.js`) end to end without the network:

| Page | Board id | Position (ground truth) | User | Moves |
|---|---|---|---|---|
| `startpos.html` | `board-single` | `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1` | white | (none yet) |
| `middlegame-castling.html` | `board-play-computer` | `r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1 w - - 0 8` | white | 14 plies, both castlings + captures |
| `flipped-black.html` | `board-single` | `rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3` | black | 4 plies, board flipped |
| `replay.html` | — | rebuilds any recorded snapshot (`?name=`/`?url=`) | — | — |
| `index.html` | — | links + explanation | — | — |

Ground truth (tests only) lives in the hidden `#fen` element of each page:
`data-fen`, `data-moves` (UCI), `data-user-color`, `data-flipped`,
`data-board-id`. The FENs are computed by **python-chess** (`generate_chesscom.py`),
i.e. by a different rules engine than the vendored chess.js the adapter replays
with — an exact string match between the two is the proof.

Regenerate with the server venv (python-chess lives there):

```bash
server/.venv/bin/python test/fixtures/generate_chesscom.py
```

Deliberate traps in every page (a naive reader fails on them):

- the chess.com **pre-JS skeleton board** (`#board.board`, same size as the real
  board, earlier in the DOM, no `.piece` children — seen live while a game page
  loads); the interactive `wc-chess-board` must win even though the skeleton is
  older/same-sized;
- a **smaller preview board** (`#board-preview`, 160×160, real pieces) earlier
  in the DOM — "largest visible board" must win;
- a **hidden board** (`#board-hidden`, `display:none`) with 2 pieces;
  the piece reader must stay scoped to the chosen board (34 pieces would trip
  the adapter's placement sanity check);
- piece class tokens in **both orders** (`piece wp square-52` and
  `piece square-38 br`) — both occur on the real site;
- player strips where the cosmetic `cc-user-block-white` /
  `cc-user-username-white` theme classes are present on **both** players
  (like the real site) — the actual color lives on the clock
  (`clock-white`/`clock-black`);
- move-list rows that contain `[data-move-list-el="timestamp"]` cells
  (`0.4s`, …) interleaved with the move nodes — timestamps must be ignored.

## How the markup was verified (2026-10-16, no login)

Everything above was checked against **live chess.com** in headless Chrome for
Testing (`~/.cache/humanplay-chrome/…/chrome`) via CDP, not from memory:

| Probe | URL | What it established |
|---|---|---|
| start position board | `https://www.chess.com/play/computer` | `wc-chess-board.board#board-play-computer`, 32 `.piece` children, `piece br square-88`… (file digit first, rank digit second), coordinates SVG inside the board, `.highlight.square-XY` last-move markers |
| real game page | `https://www.chess.com/game/live/186394589423` (public finished blitz game, URL from the public chess.com API) | `#board-single`, move list `wc-simple-move-list.move-list > .timestamps-with-base-time > .main-line-row > .node[data-node="line-ply"] > span.node-highlight-content`, timestamp cells `[data-move-list-el="timestamp"]`, player strips with `clock-top clock-black` / `clock-bottom clock-white` |
| flipped board | `https://www.chess.com/play/computer` → side selector → black | board gains the class **`flipped`**; piece `square-…` classes stay **absolute** (orientation-independent reading) |
| board-exposed state | `https://www.chess.com/analysis` and the game page | `<wc-chess-board>.game` exposes `getFEN()`, `getHistorySANs()`, `getPlayingAs()`, `getLastMove()`; `.state` (analysis page) exposes `isFlipped` |

Raw evidence excerpts (usernames stripped) are kept in `reference/`:

- `board-element.html` — the real start-position board element,
- `move-list-element.excerpt.html` — the first rows of the real move list,
- `player-strips.html` — the real player/clock markup, usernames → `user`.

The adapter treats all of this defensively: several strategies per datum, each
verified by a plausibility check, with the board's own exposed state used only
as a fallback/cross-check — see the header of `chesscom-adapter.js`.

## Run the proof

```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
node test/tools/adapter-proof.mjs --chrome "$CHROME"
```

The harness serves this directory itself (ephemeral port), injects the content
script through a temporary manifest variant (shipped manifest untouched) and
writes `../captures/adapter/*-proof.json` + panel screenshots.

## If a real chess.com page breaks the adapter (fast-fix protocol)

1. Load the extension, open the real game, press
   **Record chess.com snapshot** in the panel.
2. Move the downloaded `chesscom-snapshot-*.json` into
   `../chesscom-snapshots/` (or run `python3 test/tools/fixture_server.py` and
   record again — it saves straight into the repo).
3. `node test/tools/adapter-proof.mjs --chrome …` now replays the snapshot
   (`replay.html`) and shows exactly which value the adapter derives; then make
   a minimal fixture page from it if a full fixture is needed.
