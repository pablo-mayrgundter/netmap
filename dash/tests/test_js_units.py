"""Runs the plugins' Node unit tests (tests/js/*.test.mjs)."""

import shutil
import subprocess

import pytest

from conftest import ROOT


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_plugin_units():
    files = sorted(str(p) for p in (ROOT / "tests" / "js").glob("*.test.mjs"))
    out = subprocess.run(["node", "--test", *files], capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert out.returncode == 0, out.stdout + out.stderr
