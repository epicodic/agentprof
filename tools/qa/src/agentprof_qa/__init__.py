# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Run all quality checks: formatting, lint, type check and tests, for Python and (if set up) the frontend."""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

_FRONTEND = Path("frontend")


def _python_commands(fix: bool) -> list[list[str]]:
    return [
        ["ruff", "format"] if fix else ["ruff", "format", "--check"],
        ["ruff", "check", "--fix"] if fix else ["ruff", "check"],
        ["ty", "check"],
        ["pytest"],
    ]


def _frontend_commands(fix: bool) -> list[list[str]]:
    """Frontend checks, or none (with a note) when the frontend is not set up in this shell."""
    if not (_FRONTEND / "node_modules").is_dir() or shutil.which("pnpm") is None:
        print("note: frontend checks skipped (run ./bootstrap.sh, then use a shell with Node on PATH)", flush=True)
        return []
    pnpm = ["pnpm", "--dir", str(_FRONTEND)]
    return [[*pnpm, "lint:fix" if fix else "lint"], [*pnpm, "typecheck"], [*pnpm, "test"]]


def main(argv: list[str] | None = None) -> int:
    """Run every check, report all failures, and return a non-zero exit code if any check failed."""
    parser = argparse.ArgumentParser(prog="qa", description=__doc__)
    parser.add_argument("--fix", action="store_true", help="apply auto-fixes where possible")
    args = parser.parse_args(argv)

    failed: list[str] = []
    for command in [*_python_commands(args.fix), *_frontend_commands(args.fix)]:
        print(f"$ {' '.join(command)}", flush=True)
        if subprocess.run(command, check=False).returncode != 0:
            failed.append(" ".join(command))

    if failed:
        print(f"qa failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("qa passed")
    return 0
