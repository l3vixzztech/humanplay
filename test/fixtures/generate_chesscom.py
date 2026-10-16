#!/usr/bin/env python3
"""Generate the offline chess.com DOM fixture pages in test/fixtures/chesscom/.

These pages replicate the *real* chess.com game-page markup (verified against
live chess.com on 2026-10-16 with Chrome for Testing — see README.md in this
directory for the probe evidence), so the content-script adapter
(`extension/src/content/chesscom-adapter.js`) can be proven offline:

  - `<wc-chess-board class="board[ flipped]" id="…">` with
    `<div class="piece wp square-52">` children (square-XY = file digit + rank digit),
    `.highlight.square-XY` last-move markers, `svg.coordinates`, `.element-pool`,
  - a real move list: `<wc-simple-move-list class="move-list …">` rows
    `.main-line-row.move-list-row` with `.node[data-node="line-ply"]` >
    `span.node-highlight-content` and `[data-move-list-el="timestamp"]` cells,
  - player strips with `.clock-component.clock-top.clock-white|black` classes,
  - two traps a naive reader fails on: a smaller "next game" preview board and
    a hidden board, both also `wc-chess-board.board`,
  - a hidden ground-truth element (tests only):

        <div id="fen" data-fen="…" data-moves="…" data-name="…"
             data-user-color="…" data-flipped="…" data-board-id="…" hidden></div>

The pages are deterministic (fixed geometry, fixed clock text, no animations).
Every position is computed with python-chess from a SAN move list, so the
ground-truth FEN (castling rights, en-passant, halfmove clock, fullmove number)
is exact — the same thing the vendored chess.js reconstructs at runtime.

Run (python-chess lives in the server venv):

    server/.venv/bin/python test/fixtures/generate_chesscom.py
"""

from __future__ import annotations

import argparse
import html
import sys
from pathlib import Path

try:
    import chess
except ImportError:  # pragma: no cover - guidance, not logic
    sys.exit(
        "python-chess is required: run with the server venv, e.g.\n"
        "    server/.venv/bin/python test/fixtures/generate_chesscom.py"
    )

FIXTURES_DIR = Path(__file__).resolve().parent
DEFAULT_OUT = FIXTURES_DIR / "chesscom"

# Deterministic "time spent" labels for the move list (chess.com shows one per ply).
TIMESTAMP_PATTERN = ("0.4s", "0.9s", "0.3s", "1.2s", "0.6s", "2.1s", "0.2s", "0.7s")

# Trap element: the legacy / pre-JS skeleton board chess.com renders before its
# JS replaces it with <wc-chess-board> (observed live while a game page loads).
# Displayed, same size as the real board, earlier in the DOM, but without any
# `.piece` children — the adapter must prefer `wc-chess-board` over it.
LEGACY_BOARD_TRAP = (
    '      <div id="board" class="board" data-coordinates="1" '
    'style="position: absolute; left: 0; top: 0; width: 560px; height: 560px; '
    'pointer-events: none"></div>'
)


def square_class(file_index: int, rank_index: int) -> str:
    """chess.com square encoding: file digit first (a=1), rank digit second."""
    return f"square-{file_index + 1}{rank_index + 1}"


def screen_cell(file_index: int, rank_index: int, flipped: bool) -> tuple[int, int]:
    """Visual (col, row) in 12.5% units, 0/0 = top-left. Fixture-only cosmetics."""
    if flipped:
        return 7 - file_index, rank_index
    return file_index, 7 - rank_index


def reference_positions() -> list[dict]:
    """The three fixture games. Every SAN list is validated by python-chess."""
    return [
        {
            "slug": "startpos",
            "title": "chess.com fixture — start position (playing white)",
            "board_id": "board-single",
            "user_color": "white",
            "flipped": False,
            "top_color": "black",
            "bottom_color": "white",
            "top_player": "MaiaBot-2400",
            "bottom_player": "humanplay-session-user",
            "moves_san": (),
        },
        {
            "slug": "middlegame-castling",
            "title": "chess.com fixture — middlegame with castling + captures (playing white)",
            "board_id": "board-play-computer",
            "user_color": "white",
            "flipped": False,
            "top_color": "black",
            "bottom_color": "white",
            "top_player": "MaiaBot-2400",
            "bottom_player": "humanplay-session-user",
            # Both sides castle, several captures, ends on a quiet capture move.
            "moves_san": (
                "e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6",
                "d3", "d6", "Bg5", "O-O", "Bxf6", "Qxf6",
            ),
        },
        {
            "slug": "flipped-black",
            "title": "chess.com fixture — playing black (flipped board)",
            "board_id": "board-single",
            "user_color": "black",
            "flipped": True,
            "top_color": "white",
            "bottom_color": "black",
            "top_player": "MaiaBot-2400",
            "bottom_player": "humanplay-session-user",
            "moves_san": ("e4", "c5", "Nf3", "d6"),
        },
    ]


def replay(moves_san: tuple[str, ...]) -> tuple[str, list[str], chess.Move | None]:
    board = chess.Board()
    uci: list[str] = []
    last_move = None
    for san in moves_san:
        move = board.parse_san(san)
        board.push(move)
        uci.append(board.uci(move))
        last_move = move
    return board.fen(), uci, last_move


def board_markup(board: chess.Board, board_id: str, flipped: bool, last_move: chess.Move | None) -> str:
    highlights = ""
    if last_move is not None:
        for square in (last_move.from_square, last_move.to_square):
            highlights += (
                f'\n        <div class="highlight {square_class(chess.square_file(square), chess.square_rank(square))}"'
                f' style="background-color: rgb(255, 255, 51); opacity: 0.5;"'
                f' data-test-element="highlight" data-test-type="highlight"></div>'
            )

    pieces = ""
    for index, (square, piece) in enumerate(sorted(board.piece_map().items())):
        file_index = chess.square_file(square)
        rank_index = chess.square_rank(square)
        code = f"{'w' if piece.color == chess.WHITE else 'b'}{piece.symbol().lower()}"
        column, row = screen_cell(file_index, rank_index, flipped)
        style = f"left:{column * 12.5:g}%;top:{row * 12.5:g}%"
        # chess.com emits both token orders in the wild; alternate on purpose.
        if index % 2 == 0:
            classes = f"piece {code} {square_class(file_index, rank_index)}"
        else:
            classes = f"piece {square_class(file_index, rank_index)} {code}"
        pieces += f'\n        <div class="{classes}" style="{style}"></div>'

    coordinates = coordinates_svg(flipped)
    class_attr = "board flipped" if flipped else "board"
    return f"""      <wc-chess-board class="{class_attr}" id="{board_id}">
        {coordinates}
        <div class="element-pool"></div>
        <div class="element-pool"></div>
        <div class="element-pool"></div>{highlights}
        <!--/Pieces-->{pieces}
      </wc-chess-board>"""


def coordinates_svg(flipped: bool) -> str:
    ranks = range(8, 0, -1) if not flipped else range(1, 9)
    files = "abcdefgh" if not flipped else "hgfedcba"
    parts = []
    for index, rank in enumerate(ranks):
        y = 3.5 + index * 12.5
        tone = "coordinate-light" if index % 2 == 0 else "coordinate-dark"
        parts.append(f'<text x="0.75" y="{y:g}" font-size="2.8" class="{tone}">{rank}</text>')
    for index, file_name in enumerate(files):
        x = 10 + index * 12.5
        tone = "coordinate-dark" if index % 2 == 0 else "coordinate-light"
        parts.append(f'<text x="{x:g}" y="99" font-size="2.8" class="{tone}">{file_name}</text>')
    return f'<svg viewBox="0 0 100 100" class="coordinates" aria-hidden="true">{"".join(parts)}</svg>'


def move_list_markup(moves_san: tuple[str, ...], board_id: str) -> str:
    rows = []
    for ply in range(0, len(moves_san), 2):
        whole_move = ply // 2 + 1
        row_class = "light-row" if whole_move % 2 == 1 else "dark-row"
        nodes = []
        timestamps = []
        for offset, player in ((0, "white-move"), (1, "black-move")):
            index = ply + offset
            if index >= len(moves_san):
                continue
            san = html.escape(moves_san[index])
            nodes.append(
                f'<div data-node="0-{index}" class="node {player} main-line-ply">'
                f' <span class="node-highlight-content offset-for-annotation-icon">{san} </span></div>'
            )
            stamp = TIMESTAMP_PATTERN[index % len(TIMESTAMP_PATTERN)]
            time_class = "time-white" if offset == 0 else "time-black"
            timestamps.append(
                f'<div data-move-list-el="timestamp" data-ply="{index + 1}" '
                f'class="{time_class}">{stamp}</div>'
            )
        rows.append(
            f'<div class="main-line-row move-list-row {row_class}" data-whole-move-number="{whole_move}">'
            f'{whole_move}.  {"  ".join(nodes)}  {"".join(timestamps)}</div>'
        )
    body = "\n        ".join(rows)
    return f"""      <wc-simple-move-list class="move-list chessboard-pkg-move-list-component" board-id="{board_id}">
        <div class="timestamps-with-base-time">
        {body}
        </div>
      </wc-simple-move-list>"""


def player_strip(side: str, color: str, username: str) -> str:
    title = "player-top" if side == "top" else "player-bottom"
    layout = "board-layout-top" if side == "top" else "board-layout-bottom"
    # NOTE: like the real site, the *theme* classes (`cc-user-block-white`,
    # `cc-user-username-white`) appear on both players — they are cosmetics and
    # must not be mistaken for the player's color. The color lives on the clock.
    return f"""        <div id="board-layout-player-{side}" class="board-layout-player {layout}">
          <div class="player-component {title}">
            <div class="player-avatar"><img class="cc-avatar-img" alt="Avatar" src="about:blank" width="40" height="40" /></div>
            <div class="player-tagline">
              <div class="cc-user-block-component cc-user-block-white cc-user-block-small">
                <div role="button" tabindex="0" class="cc-text-medium-bold cc-user-username-component cc-user-username-white" data-test-element="user-tagline-username">{html.escape(username)}</div>
              </div>
            </div>
            <div class="clock-component clock-{side} clock-{color}"><span class="clock-time-monospace" role="timer">10:00</span></div>
          </div>
        </div>"""


PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="humanplay-fixture" content="chesscom-{slug}" />
    <title>{title}</title>
    <style>
      /* Deterministic, chess.com-ish, no external resources. Piece visuals are
         fixture-only (chess.com paints them from its own stylesheet); the
         adapter reads classes, never pixels or styles. */
      html, body {{ margin: 0; background: #312e2b; color: #e8e6e3;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }}
      #board-layout-main {{ display: flex; gap: 20px; padding: 18px; align-items: flex-start; }}
      .board-column {{ display: flex; flex-direction: column; gap: 8px; }}
      .player-component {{ display: flex; align-items: center; gap: 10px; padding: 4px 2px; }}
      .cc-user-username-component {{ font-weight: 600; }}
      .clock-time-monospace {{ font-variant-numeric: tabular-nums; font-size: 18px; }}
      wc-chess-board.board {{
        display: block; position: relative; width: 560px; height: 560px;
        background: repeating-conic-gradient(#ebecd0 0% 25%, #779556 0% 50%);
        background-size: 25% 25%;
        border-radius: 4px;
      }}
      wc-chess-board.board-preview {{
        width: 160px; height: 160px; margin: 6px 0 14px;
      }}
      wc-chess-board .coordinates {{ position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }}
      wc-chess-board .coordinates text {{ font-size: 2.8px; font-weight: 700; }}
      .coordinate-light {{ fill: #ebecd0; }} .coordinate-dark {{ fill: #779556; }}
      .piece {{ position: absolute; width: 12.5%; height: 12.5%; display: flex;
        align-items: center; justify-content: center; border-radius: 50%;
        background: #f7f7f7; box-shadow: inset 0 0 0 2px rgba(0,0,0,0.45); }}
      .piece.bp, .piece.bn, .piece.bb, .piece.br, .piece.bq, .piece.bk {{ background: #262421; }}
      .piece::after {{ font: 700 26px/1 system-ui, sans-serif; }}
      .piece.wp::after {{ content: "P"; color: #57534e; }} .piece.bp::after {{ content: "P"; color: #c8c6c4; }}
      .piece.wn::after {{ content: "N"; color: #57534e; }} .piece.bn::after {{ content: "N"; color: #c8c6c4; }}
      .piece.wb::after {{ content: "B"; color: #57534e; }} .piece.bb::after {{ content: "B"; color: #c8c6c4; }}
      .piece.wr::after {{ content: "R"; color: #57534e; }} .piece.br::after {{ content: "R"; color: #c8c6c4; }}
      .piece.wq::after {{ content: "Q"; color: #57534e; }} .piece.bq::after {{ content: "Q"; color: #c8c6c4; }}
      .piece.wk::after {{ content: "K"; color: #57534e; }} .piece.bk::after {{ content: "K"; color: #c8c6c4; }}
      .highlight {{ position: absolute; width: 12.5%; height: 12.5%; }}
      #board-layout-sidebar {{ width: 260px; background: #262421; border-radius: 6px; padding: 10px 12px; }}
      #board-layout-sidebar h2 {{ font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #a8a6a4; margin: 0 0 6px; }}
      wc-simple-move-list .move-list-row {{ display: grid; grid-template-columns: 28px 1fr 1fr; gap: 2px 8px; font-size: 14px; padding: 1px 4px; }}
      wc-simple-move-list .move-list-row.dark-row {{ background: rgba(255,255,255,0.04); }}
      wc-simple-move-list .node {{ font-weight: 500; }}
      wc-simple-move-list [data-move-list-el="timestamp"] {{ display: none; }}
      .fixture-note {{ padding: 0 18px 24px; color: #a8a6a4; font-size: 12px; max-width: 900px; }}
    </style>
  </head>
  <body>
    <div id="board-layout-main">
      <div class="board-column">
{top_player}
{legacy_board}
{board}
{bottom_player}
      </div>

      <aside id="board-layout-sidebar" class="board-layout-sidebar">
        <h2>Next game</h2>
        <!-- Trap: a smaller, fully valid chess.com-style board. -->
        <wc-chess-board class="board board-preview" id="board-preview">
          <div class="piece wk square-51" style="left:12.5%;top:87.5%"></div>
          <div class="piece bk square-58" style="left:37.5%;top:0%"></div>
        </wc-chess-board>
        <h2>Moves</h2>
{move_list}
      </aside>
    </div>

    <!-- Trap: a hidden board must never be selected. -->
    <div hidden>
      <wc-chess-board class="board" id="board-hidden">
        <div class="piece wk square-11"></div>
        <div class="piece bk square-88"></div>
      </wc-chess-board>
    </div>

    <p class="fixture-note">
      Offline fixture replicating the chess.com game-page DOM (verified 2026-10).
      Ground truth below is for tests only; the runtime adapter must read the
      visible DOM the same way it does on the real site.
    </p>

    <!-- Test ground truth only. -->
    <div
      id="fen"
      data-fen="{fen}"
      data-moves="{moves}"
      data-name="chesscom-{slug}"
      data-user-color="{user_color}"
      data-flipped="{flipped}"
      data-board-id="{board_id}"
      hidden
    ></div>
  </body>
</html>
"""

INDEX_TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="humanplay-fixture" content="chesscom-index" />
    <title>humanplay chess.com fixtures</title>
    <style>
      body {{ font-family: system-ui, sans-serif; margin: 24px; background: #312e2b; color: #e8e6e3; }}
      li {{ margin: 8px 0; }}
      code {{ background: #262421; padding: 2px 5px; border-radius: 4px; font-size: 12px; }}
      a {{ color: #7fa650; }}
    </style>
  </head>
  <body>
    <h1>humanplay — chess.com DOM fixtures</h1>
    <p>
      Generated by <code>test/fixtures/generate_chesscom.py</code>; replicas of the real
      chess.com game-page markup. Ground truth lives in a hidden <code>#fen</code> element
      on each page (tests only). Serve over HTTP for the extension proof:
      <code>python3 test/tools/fixture_server.py</code> →
      <code>http://127.0.0.1:8765/chesscom/index.html</code>.
    </p>
    <ul>
{items}
    </ul>
    <p><code>replay.html?name=&lt;snapshot&gt;.json</code> rebuilds a page from a recorded
    snapshot in <code>test/fixtures/chesscom-snapshots/</code>.</p>
  </body>
</html>
"""


def render_page(spec: dict, board: chess.Board, uci: list[str], last_move: chess.Move | None) -> str:
    return PAGE_TEMPLATE.format(
        slug=spec["slug"],
        title=html.escape(spec["title"]),
        top_player=player_strip("top", spec["top_color"], spec["top_player"]),
        bottom_player=player_strip("bottom", spec["bottom_color"], spec["bottom_player"]),
        legacy_board=LEGACY_BOARD_TRAP,
        board=board_markup(board, spec["board_id"], spec["flipped"], last_move),
        move_list=move_list_markup(spec["moves_san"], spec["board_id"]),
        fen=board.fen(),
        moves=" ".join(uci),
        user_color=spec["user_color"],
        flipped="true" if spec["flipped"] else "false",
        board_id=spec["board_id"],
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output dir (default {DEFAULT_OUT})")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    items = []
    for spec in reference_positions():
        fen, uci, last_move = replay(spec["moves_san"])
        # Sanity: the ground truth we publish must be a legal, non-ep-loose FEN.
        board = chess.Board()
        for san in spec["moves_san"]:
            board.push_san(san)
        assert board.fen() == fen
        target = args.out / f"{spec['slug']}.html"
        target.write_text(render_page(spec, board, uci, last_move), encoding="utf-8")
        print(f"wrote {target} ({target.stat().st_size} bytes)")
        print(f"    fen   = {fen}")
        print(f"    moves = {' '.join(uci) if uci else '(none)'}")
        print(f"    user  = {spec['user_color']}  flipped = {spec['flipped']}  board = {spec['board_id']}")
        items.append(
            f'      <li><a href="{spec["slug"]}.html">{html.escape(spec["title"])}</a> — '
            f'<code>{fen}</code><br /><code>{" ".join(uci) if uci else "(no moves)"}</code></li>'
        )

    index = args.out / "index.html"
    index.write_text(INDEX_TEMPLATE.format(items="\n".join(items)), encoding="utf-8")
    print(f"wrote {index} ({index.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
