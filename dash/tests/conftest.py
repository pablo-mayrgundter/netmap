"""Fixtures: the deployment's config, a built site served statically (as
GitHub Pages would), and Chromium for the demo-mode page tests.

bizdash is installed at the release the workflows pin (see README, "Local
development"); nothing here needs credentials or the network."""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
CONFIG_PATH = SITE / "bizdash.config.json"


@pytest.fixture(scope="session")
def raw_config():
    return json.loads(CONFIG_PATH.read_text())


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class StaticServer:
    def __init__(self, directory):
        self.port = _free_port()
        self.proc = subprocess.Popen([sys.executable, "-m", "http.server", str(self.port), "--bind", "127.0.0.1"],
                                     cwd=directory, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.25):
                    break
            except OSError:
                if self.proc.poll() is not None:
                    raise RuntimeError("static server exited early")
                time.sleep(0.05)
        self.url = f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)


@pytest.fixture(scope="session")
def build(tmp_path_factory):
    """build(config_override=None) -> base URL of the built site, served.
    An override replaces bizdash.config.json in a copy of site/."""
    from bizdash.build import build_site
    servers = []

    def make(config=None):
        out = tmp_path_factory.mktemp("site")
        warnings = build_site(out, SITE, force=True)
        assert warnings == [], warnings
        if config is not None:
            (out / "bizdash.config.json").write_text(json.dumps(config))
        srv = StaticServer(out)
        servers.append(srv)
        return srv.url
    yield make
    for s in servers:
        s.stop()


@pytest.fixture(scope="session")
def site_url(build):
    return build()


def _chromium_executable():
    explicit = os.environ.get("BIZDASH_TEST_CHROMIUM")
    if explicit:
        return explicit
    return None


@pytest.fixture(scope="session")
def browser():
    pw = pytest.importorskip("playwright.sync_api")
    with pw.sync_playwright() as p:
        exe = _chromium_executable()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        yield b
        b.close()


@pytest.fixture
def open_page(browser):
    """open_page(url, width=1440) -> the dashboard, loaded and settled.
    Any uncaught page error fails the test."""
    contexts = []

    def opener(url, width=1440):
        ctx = browser.new_context(viewport={"width": width, "height": 900})
        page = ctx.new_page()
        page.errors = []
        page.on("pageerror", lambda e: page.errors.append(str(e)))
        contexts.append((ctx, page))
        page.goto(url)
        page.wait_for_function("window.bizdashReady !== undefined")
        page.evaluate("window.bizdashReady")
        page.wait_for_function("document.querySelectorAll('.card').length > 0 "
                               "&& !document.querySelector('.card.loading')", timeout=30000)
        return page
    yield opener
    for ctx, page in contexts:
        errors = list(page.errors)
        ctx.close()
        assert not errors, f"uncaught page errors: {errors}"
