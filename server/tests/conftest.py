"""Pytest configuration: make `server/` importable and share the engine."""

from __future__ import annotations

import pathlib
import sys

import pytest

SERVER_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import maia_engine  # noqa: E402


@pytest.fixture(scope="session")
def engine() -> maia_engine.MaiaEngine:
    """Session-wide engine singleton (model loads once, ~seconds)."""
    return maia_engine.get_engine()
