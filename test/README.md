# test/ — offline test fixtures (placeholder)

Cross-cutting test assets live here (Milestone 2+). Server unit tests live in
`../server/tests/`.

## Planned contents

- `test/fixtures/` — screenshots of boards on real sites (chess.com, lichess,
  custom pages) at several sizes/themes, used as *offline* inputs for
  board-localization (M3) and piece-classification (M4) tests.
- `test/groundtruth/` — optional DOM-scraped FENs recorded next to each
  screenshot, used **only** as test ground truth. The runtime pipeline stays
  pixel-only.
- `test/manual/` — scripts for manual end-to-end checks (M6+).

Nothing here may import or bundle Maia-3 code (AGPL boundary, see
`../docs/PROJECT.md`).
