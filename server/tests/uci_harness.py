"""Minimal subprocess harness for driving the real ``maia3-uci`` CLI.

Used by the golden test (``test_golden_uci.py``) and the documentation report
(``golden_report.py``) to compare our in-process ``maia_engine.predict()``
against the reference implementation shipped with Maia-3.

Runs: ``<venv>/python -m maia3.uci --model maia3-5m --temperature 0 ...`` and
speaks the UCI protocol over stdin/stdout. stderr is discarded by default (the
engine logs checkpoint loading there).
"""

from __future__ import annotations

import queue
import re
import subprocess
import sys
import threading
import time
from typing import Dict, List, Optional, Sequence, Tuple

INFO_RE = re.compile(
    r"^info depth (\d+) multipv (\d+) score cp (-?\d+) wdl (\d+) (\d+) (\d+) pv (\S+)$"
)


class UciReferenceEngine:
    """Reference Maia-3 engine (real ``maia3-uci`` process)."""

    def __init__(
        self,
        model: str = "maia3-5m",
        elo: int = 2400,
        multipv: int = 3,
        temperature: float = 0.0,
        use_uci_history: bool = True,
        device: str = "cpu",
        verbose: bool = False,
    ) -> None:
        self.verbose = verbose
        cmd = [
            sys.executable,
            "-m",
            "maia3.uci",
            "--model",
            model,
            "--device",
            device,
            "--temperature",
            str(temperature),
            "--multipv",
            str(multipv),
            "--elo",
            str(elo),
            "--no-use-amp",
        ]
        if use_uci_history:
            cmd.append("--use-uci-history")

        stderr = None if verbose else subprocess.DEVNULL
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            bufsize=1,
        )
        self._lines: "queue.Queue[Optional[str]]" = queue.Queue()
        self._reader = threading.Thread(target=self._pump, daemon=True)

    # -- plumbing ----------------------------------------------------------

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        try:
            for line in self.proc.stdout:
                self._lines.put(line.rstrip("\n"))
        finally:
            self._lines.put(None)

    def _send(self, line: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def _read_until(self, predicate, timeout: float, context: str) -> List[str]:
        deadline = time.monotonic() + timeout
        collected: List[str] = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"timed out waiting for {context}; got: {collected!r}")
            try:
                line = self._lines.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(
                    f"timed out waiting for {context}; got: {collected!r}"
                ) from None
            if line is None:
                raise RuntimeError(f"maia3-uci exited while waiting for {context}")
            collected.append(line)
            if predicate(line):
                return collected

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> "UciReferenceEngine":
        self._reader.start()
        self._send("uci")
        self._read_until(lambda line: line == "uciok", timeout=60.0, context="uciok")
        return self

    def ready(self, timeout: float = 900.0) -> None:
        """Trigger model load in the subprocess and wait for readiness."""
        self._send("isready")
        self._read_until(lambda line: line == "readyok", timeout=timeout, context="readyok")

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self._send("quit")
                self.proc.wait(timeout=10.0)
        except Exception:
            self.proc.kill()
        finally:
            self._reader.join(timeout=5.0)

    def __exit__(self, *_exc) -> None:
        self.close()

    # -- analysis ----------------------------------------------------------

    def analyze(
        self,
        fen: Optional[str] = None,
        moves: Sequence[str] = (),
        timeout: float = 300.0,
    ) -> Dict[str, object]:
        """Run ``position ...`` + ``go`` and collect the MultiPV info lines."""
        command = f"position fen {fen}" if fen else "position startpos"
        if moves:
            command += " moves " + " ".join(moves)
        self._send(command)
        self._send("go")
        lines = self._read_until(
            lambda line: line.startswith("bestmove"), timeout=timeout, context="bestmove"
        )

        multipv: Dict[int, Dict[str, object]] = {}
        for line in lines:
            match = INFO_RE.match(line)
            if match:
                rank = int(match.group(2))
                multipv[rank] = {
                    "rank": rank,
                    "cp": int(match.group(3)),
                    "wdl": (int(match.group(4)), int(match.group(5)), int(match.group(6))),
                    "pv": match.group(7),
                }

        return {
            "bestmove": lines[-1].split()[1],
            "multipv": [multipv[rank] for rank in sorted(multipv)],
        }


def reference_top_moves(result: Dict[str, object], n: int = 3) -> List[str]:
    return [str(entry["pv"]) for entry in list(result["multipv"])[:n]]
