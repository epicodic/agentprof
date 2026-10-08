# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""The `agentprof` command: start the registry and the local server, and open the browser."""

import argparse
import contextlib
import ipaddress
import socket
import sys
import webbrowser
from collections.abc import Callable
from pathlib import Path
from types import FrameType
from urllib.parse import quote

import uvicorn
from fastapi import FastAPI

from agentprof.adapters import load_adapters
from agentprof.adapters.base import AdapterConfig
from agentprof.pricing import PriceTable
from agentprof.registry import Registry
from agentprof.server.app import create_app

_DEFAULT_HOST = "127.0.0.1"
_DEFAULT_PORT = 8765
_WILDCARD_HOSTS = ("0.0.0.0", "::")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agentprof", description="Analyse AI coding agent sessions in the browser.")
    parser.add_argument("session", nargs="?", help="session id ('<agent>:<id>' or a bare id) or session file to open")
    parser.add_argument("--host", default=_DEFAULT_HOST, help="interface to bind (default: %(default)s)")
    parser.add_argument("--port", type=int, default=_DEFAULT_PORT, help="port to bind (default: %(default)s)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    parser.add_argument("--copilot-root", type=Path, help="VS Code workspaceStorage directory")
    parser.add_argument("--claude-root", type=Path, help="Claude Code projects directory")
    parser.add_argument("--codex-root", type=Path, help="Codex CLI sessions directory")
    parser.add_argument("--pricing", type=Path, help="JSON price table replacing the bundled one")
    return parser


def adapter_config(args: argparse.Namespace) -> AdapterConfig:
    roots: dict[str, Path] = {}
    if args.copilot_root is not None:
        roots["copilot-vscode"] = args.copilot_root
    if args.claude_root is not None:
        roots["claude-code"] = args.claude_root
    if args.codex_root is not None:
        roots["codex"] = args.codex_root
    return AdapterConfig(roots=roots, pricing_file=args.pricing)


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def browser_url(host: str, port: int, session_id: str | None) -> str:
    shown_host = "localhost" if host in _WILDCARD_HOSTS else host
    base = f"http://{shown_host}:{port}/"
    return f"{base}sessions/{quote(session_id, safe='')}" if session_id is not None else base


class _Server(uvicorn.Server):
    """A server that calls `on_started` once it accepts connections and ends open event streams on the first Ctrl+C.

    Without the latter, the shutdown would wait for the browser to disconnect.
    """

    def __init__(self, config: uvicorn.Config, end_streams: Callable[[], None], on_started: Callable[[], None]) -> None:
        super().__init__(config)
        self._end_streams = end_streams
        self._on_started = on_started

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets)
        if not self.should_exit:
            self._on_started()

    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        self._end_streams()
        super().handle_exit(sig, frame)


def _serve(app: FastAPI, host: str, port: int, on_started: Callable[[], None]) -> None:
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    with contextlib.suppress(KeyboardInterrupt):  # uvicorn re-raises the signal that stopped it, as `uvicorn.run` does
        _Server(config, app.state.end_streams, on_started).run()


def main(
    argv: list[str] | None = None,
    *,
    serve: Callable[[FastAPI, str, int, Callable[[], None]], None] = _serve,
    open_browser: Callable[[str], object] = webbrowser.open,
) -> int:
    """Run agentprof until interrupted; returns the process exit code."""
    args = build_parser().parse_args(argv)
    try:
        registry = Registry(load_adapters(adapter_config(args)))
        pricing = PriceTable.load(args.pricing)
    except (OSError, ValueError) as error:  # e.g. an unreadable or invalid --pricing file
        print(f"error: {error}", file=sys.stderr)
        return 2
    registry.refresh()

    session_id: str | None = None
    if args.session is not None:
        try:
            session_id = registry.resolve(args.session)
        except LookupError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2

    if not is_loopback(args.host):
        print(
            f"warning: serving on {args.host} without authentication; anyone who can reach it can read your sessions",
            file=sys.stderr,
        )
    url = browser_url(args.host, args.port, session_id)

    def _on_started() -> None:
        if not args.no_browser:
            open_browser(url)

    app = create_app(registry, pricing=pricing)
    print(f"agentprof: {url}", flush=True)
    registry.start()
    try:
        serve(app, args.host, args.port, _on_started)
    except OSError as error:  # e.g. the port is already in use
        print(f"error: cannot serve on {args.host}:{args.port}: {error}", file=sys.stderr)
        return 2
    finally:
        registry.stop()
    return 0
