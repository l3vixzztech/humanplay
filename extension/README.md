# humanplay — Chrome extension (placeholder)

This directory will hold the Chrome MV3 extension (Milestone 2 onward).

## Status

Empty placeholder. No extension code exists yet; Milestone 1 is server-only.

## Hard boundaries (locked decisions)

- **No Maia-3 code here, ever.** Maia-3 is AGPL-3.0 and lives only as a separate
  local process/venv (see `../server/`). The extension never imports, bundles,
  copies, or vendored-copies any part of the `maia3` package or its server code.
  The only interface is HTTP to `http://127.0.0.1:8765`.
- **Pixel-based position recognition.** The extension captures the tab as pixels
  and derives the board/FEN from the image. DOM scraping may be used only as
  optional ground-truth on specific sites during tests, never as a runtime
  dependency.
- **Capture must be an abstraction.** Tab capture goes through a capture-source
  interface so a desktop-capture source (explicitly out of scope for now) can be
  added later without touching downstream code.

## Planned layout (Milestone 2+)

```
extension/
  manifest.json        # MV3
  src/
    background/        # service worker, tab capture orchestration
    capture/           # capture-source interface + browser-tab source
    board/             # board locator + piece classifier -> FEN (M3/M4)
    tracker/           # legal-move game tracker (M5)
    ui/                # overlay + side panel (M7) + TTS (M8)
```

## Server it talks to

```bash
cd ../server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
```

See `../server/README.md` and `../docs/PROJECT.md`.
