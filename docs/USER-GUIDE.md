# humanplay — User Guide

This guide takes you from a fresh machine to playing with the assistant on.
No programming knowledge is needed beyond copying a few commands into a
terminal.

---

## 1. What this is

humanplay is a Chrome extension for **chess.com**. It reads the game on your
screen, asks a small chess AI (Maia-3) that runs **on your own computer** which
move a strong human would most likely play, and can:

- show the suggested move as an **arrow on the board**,
- **speak** the move out loud,
- plan **one safe premove** while your opponent is thinking,
- explain **every move** in one short sentence (yours and your opponent's).

Maia-3 is not a chess engine like Stockfish: it predicts **what humans play**,
not the objectively best move. That is the whole point — the suggestions look
like a strong human's choices.

**Fair play note:** using a move assistant in live games on chess.com can get
your account banned. The tool is intended for playing against bots, study and
fun; the risk in live games is yours.

---

## 2. Install

### 2.1 The helper server (once)

The server runs Maia-3 on your machine and listens only on `127.0.0.1:8765`
(other programs on the internet cannot reach it).

Open a terminal in the project folder and run:

```bash
scripts/setup-server.sh
```

This is a one-time setup; it needs [uv](https://docs.astral.sh/uv/) (a Python
installer). It creates the environment, downloads the dependencies and the
Maia-3 model checkpoints (5M + 79M). Running it again later is safe.

### 2.2 The extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension` folder inside the project folder
5. Pin the humanplay icon: click the puzzle-piece icon in the toolbar and
   press the pin next to *humanplay*

(If you were given a `.zip` package instead: unzip it anywhere and select the
unzipped folder in step 4.)

---

### 2.3 Choosing the model (optional)

The server runs **Maia3-79M** by default — the most accurate model in the
Maia-3 family (better human-move prediction than the smaller models; ~300 MB of
disk; still fast: usually well under half a second per move on CPU). To use the
smaller, faster model instead:

```bash
HUMANPLAY_MODEL=maia3-5m scripts/run-server.sh
```

The **Server chip** in the panel always shows which model is running.

## 3. First run

1. **Start the server** (leave the terminal window open):

   ```bash
   scripts/run-server.sh
   ```

2. Open a game on chess.com (a **bot game** is the easiest way to try it).
3. Click the **humanplay icon** in the Chrome toolbar (or the puzzle-piece icon
   → humanplay). The side panel opens on the right.
4. The **Server** chip at the bottom should say *online · maia3-79m · v1.0.0*.
   The **chess.com game state** card should show your position, the move list
   and “you play white/black”.
5. Leave the **Assistant** switch on (it is on by default).

On **your turn** you will see the *Maia suggestion* card fill with the top-3
moves and probabilities (usually within a second), and an orange arrow appear
on the board for the first move.

**Turn on the voice** if you want to hear the move: open the **Voice (TTS)**
card and tick **Speak suggestion**. You can also press **Ctrl+Shift+Y** at any
time — the toolbar badge shows a green `TTS` while it is on. The first sound
may take a second.

---

## 4. Controls

| Control | What it does |
|---|---|
| **Toolbar icon** (or the puzzle-piece → humanplay) | Opens the side panel. Use it on the chess.com tab you play in. |
| **Ctrl+Shift+Y** | Toggles the voice on/off from anywhere, even with the panel closed. |
| **Assistant** switch | Master switch: when off, nothing is computed automatically; the *Analyze now* button still works. |
| **Analyze now** | Computes a suggestion for the current position right away (works on your opponent's turn too). |
| **Refresh state** (game-state card) | Re-reads the board if the panel looks out of date. |
| **Record chess.com snapshot** | Saves the page's game information to a file (see *Troubleshooting*). |
| **Copy start command** (Server card) | Copies the command that starts the server. |

---

## 5. Settings reference

### Elo (the *Elo* card)

- **you** — the strength the model assumes for you (0–5000, default 2400).
- **opponent** — the strength assumed for the other player.
- Press **reset to 2400** to go back.

Changing these changes the suggestions (a 1200 player and a 2600 player do not
pick the same move). The cards re-analyze immediately.

### Arrows (*Maia suggestion* card)

- **Show arrows on board** — draw the suggested move on the board (default on).
- **Show alternatives** — also draw the 2nd and 3rd suggestion, thinner
  (default off).

### Premove (*Premove* card)

- **Show premove arrow** — draw the recommended premove as a dashed blue arrow
  (default on; only applies while arrows are shown).
- **Speak premoves** — say “premove …” out loud (default on; needs the voice
  switched on).

### Voice (*Voice (TTS)* card)

- **Speak suggestion** — read the suggested move aloud (default **off**).
- **rate** — speaking speed (0.8 slow / 1.0 / 1.2 fast).
- **Speak test** — says “Knight to f3” so you can check your sound.
- The line under it shows how many voices Chrome found.

Only the *move* is spoken (“Knight to f3”, “e-pawn takes d5”), never the
probabilities.

### Commentary (*Commentary* card)

- **Explain moves** — describe every move that lands, yours and your
  opponent's, in one factual sentence (default on). This works even with the
  assistant switched off — it never suggests a move, it only explains.
- **Phrasing** — how the sentence is written:
  - **Templates** (default) — built locally from the facts. No key, no
    internet.
  - **Groq** / **Gemini** — sends the same facts to a free online LLM service
    so it rephrases them conversationally. You need your own free API key, and
    Chrome will ask for permission to contact that site the first time.
- **API key** — your provider key. It is stored **only on this computer**
  (`chrome.storage.local`), never synced, never logged, never shown again in
  the panel.
- **Test connection** — sends one tiny test request so you know the key works.

The privacy line under the key field tells you exactly which site the
positions go to when a provider is selected.

---

## 6. Troubleshooting

### “server offline” on a card

The helper server is not running (or was stopped). Every card shows the same
actionable message. Fix it in one of two ways:

- Press **Copy start command** in the Server card, paste it into a terminal
  and press Enter, **or** type the command yourself:

  ```bash
  cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
  ```

You do not need to restart the extension: the panel re-checks every few
seconds and picks up where it left off as soon as the server answers again.

If it still says offline, check the terminal for an error and see
`server/README.md`.

### No voices / no sound on Linux

Chrome on Linux needs a speech backend and a start-up flag:

1. Install the backend once:
   `sudo apt install speech-dispatcher espeak-ng` (Debian/Ubuntu)
2. Start Chrome with the speech flag:
   `google-chrome --enable-speech-dispatcher` (or start your Chrome the usual
   way but add that flag to its launcher)
3. In the panel, **Voice (TTS)** → press **Speak test**.

Without the flag, the extension still *records* what it would say (you can see
the decision in the panel), but Chrome produces no audio — the panel shows a
note that says exactly this.

### The arrow points at the wrong squares / no arrow

The extension tells you when it is unsure: the *chess.com game state* card
shows **warnings** or a **mismatch** message. When chess.com changes its page
markup, the reader can no longer be sure about the position and it says so
instead of guessing.

**Fast fix (snapshot protocol):**

1. On the game page, press **Record chess.com snapshot** in the panel. A JSON
   file is downloaded (and, if the fixture server is running, copied straight
   into the repository).
2. Give that file to whoever maintains your copy of humanplay, or follow
   `test/fixtures/chesscom/README.md`: drop it into
   `test/fixtures/chesscom-snapshots/` and run

   ```bash
   node test/tools/adapter-proof.mjs --chrome "$CHROME"
   ```

   The replay shows exactly what the reader parses from that page, so the
   markup change can be fixed and re-tested quickly.

### “no safe premove”

This is not a bug — see the FAQ below.

### The commentary says nothing / only the next move is explained

The commentary starts with the next move it *sees*. If you open the panel in
the middle of a game it will not go back and explain the moves you played
before. Same after a rematch: the feed starts fresh.

### Nothing happens at all

- Make sure the side panel is open on the **same tab** as the game.
- Press **Refresh state** in the game-state card.
- Reload the chess.com page once if you installed or updated the extension
  while the page was already open.

---

## 7. FAQ

**Why Maia and not Stockfish?**
Because the goal is to play like a strong human. Stockfish picks the
objectively best move — often something no human would ever play, and easy for
opponents to spot. Maia-3 was trained on millions of human games and answers
“what would a ~2400 player play here?”, which is exactly what this tool repeats
(including its mistakes).

**Why does the premove card sometimes say nothing / stay quiet?**
By design. A premove fires the moment it becomes legal, even if your opponent
plays something else — that is how premoves can lose material. The planner only
recommends a premove when it can prove it is safe against the opponent's likely
moves; otherwise it says **“no safe premove”** and leaves you on manual play.
A quiet card is the feature, not a failure.

**Is my position sent anywhere?**
Only to the Maia-3 server on your own computer — unless *you* select Groq or
Gemini under **Phrasing**. In that case the same facts the template uses are
sent to that provider so it can rephrase them, with your own key. Templates
need no key and no internet.

**Does the voice work with the panel closed?**
Yes. Speech is handled by the extension's background service, so
`Ctrl+Shift+Y` and the spoken moves keep working when the panel is closed.

**Can I use it on other chess sites?**
No — the reader is built for chess.com only.

**Is it detectable? / Does it hide itself?**
The tool deliberately ships **no** anti-detection features. It reads the page
like a screen reader and shows you the answer; it does not modify the page,
click for you or hide its presence.

**Where is the evidence that it works?**
Every feature is covered by automated proofs with screenshots and JSON reports
in `test/fixtures/captures/` (see `docs/RELEASE-NOTES.md` and
`docs/HANDOFF.md`).
