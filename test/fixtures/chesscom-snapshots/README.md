# test/fixtures/chesscom-snapshots — real chess.com snapshots (user-recorded)

This folder is where **real chess.com pages** become fixtures. It is empty
until someone records a snapshot on a live game — that is expected, the proof
harness reports `SKIP snapshot-replay (real)` and still passes.

## Record a snapshot (the dev/test tool)

1. Load the extension (`extension/README.md`) and open a real game on
   chess.com (a bot game is fine).
2. In the humanplay side panel, press **Record chess.com snapshot**.
   The content script serializes the live DOM into a sanitized JSON snapshot:
   board `outerHTML`, move-list `outerHTML`, sanitized player strips, the
   extracted `GameState`, board rect, devicePixelRatio and the URL.
   **Usernames are stripped** (replaced with `user`), member links are
   neutralised and avatar URLs pointing at user uploads are removed.
3. Get the file into this folder — one of:
   - start the dev server first (`python3 test/tools/fixture_server.py`) and the
     panel writes the snapshot straight into this directory via
     `POST /snapshot`; or
   - move the downloaded `~/Downloads/chesscom-snapshot-<timestamp>.json` here.

## What uses them

`test/tools/adapter-proof.mjs` replays every `*.json` here through
`../chesscom/replay.html`: the page is rebuilt from the snapshot and the
adapter must parse it back into the **same** state (exact FEN, UCI history,
user color, flipped flag). This is the "make a fixture from a real page in one
click" loop — see `../chesscom/README.md` for the fast-fix protocol.

The file name matters only for ordering; the schema field is
`humanplay.chesscom.snapshot/1`. Snapshots are safe to commit (they contain no
usernames and no credentials), but keep them small: record from the game you
actually need to debug.
