# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Build the frontend, wheel and sdist, check their contents, and smoke-test the wheel.

Run: `uv run build-dist` from the repository root.
"""

import argparse
import shutil
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from pathlib import Path

from agentprof_qa.smoke import SmokeError, find_wheel, smoke_test

_DIST = Path("dist")
_REQUIRED_WHEEL_FILES = ("agentprof/server/static/index.html", "agentprof/pricing.json")
_WHEEL_ASSETS = "agentprof/server/static/assets/"
_SDIST_INDEX = "src/agentprof/server/static/index.html"


def project_version(pyproject: Path = Path("pyproject.toml")) -> str:
    return tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]


def check_wheel(wheel: Path, version: str) -> list[str]:
    """Problems with the wheel's name or contents; empty if it is complete."""
    problems: list[str] = []
    if not wheel.name.startswith(f"agentprof-{version}-"):
        problems.append(f"wheel {wheel.name} does not carry version {version}")
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    problems += [f"wheel lacks {name}" for name in _REQUIRED_WHEEL_FILES if name not in names]
    if not any(name.startswith(_WHEEL_ASSETS) for name in names):
        problems.append(f"wheel lacks frontend assets under {_WHEEL_ASSETS}")
    return problems


def check_sdist(sdist: Path, version: str) -> list[str]:
    """Problems with the sdist's contents; empty if it contains the built frontend."""
    with tarfile.open(sdist) as archive:
        names = set(archive.getnames())
    required = f"agentprof-{version}/{_SDIST_INDEX}"
    return [] if required in names else [f"sdist lacks {_SDIST_INDEX}"]


def _run(command: list[str]) -> None:
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, check=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="build-dist", description=__doc__)
    parser.add_argument("--skip-smoke", action="store_true", help="skip installing and running the wheel")
    args = parser.parse_args(argv)
    if shutil.which("pnpm") is None:
        print("error: pnpm not found; run ./bootstrap.sh and use a shell with Node on PATH", file=sys.stderr)
        return 2
    try:
        _run(["pnpm", "--dir", "frontend", "install", "--frozen-lockfile"])
        _run(["pnpm", "--dir", "frontend", "build"])
        shutil.rmtree(_DIST, ignore_errors=True)
        _run(["uv", "build", "--out-dir", str(_DIST)])
    except subprocess.CalledProcessError as error:
        print(f"error: {' '.join(map(str, error.cmd))} failed with exit code {error.returncode}", file=sys.stderr)
        return 1

    version = project_version()
    sdist = _DIST / f"agentprof-{version}.tar.gz"
    try:
        wheel = find_wheel(_DIST)
    except SmokeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    problems = check_wheel(wheel, version) + (check_sdist(sdist, version) if sdist.is_file() else [f"missing {sdist}"])
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        return 1

    if not args.skip_smoke:
        try:
            smoke_test(wheel)
        except SmokeError as error:
            print(f"smoke test failed: {error}", file=sys.stderr)
            return 1
    print(f"build-dist: {wheel.name} and {sdist.name} are ready in {_DIST}/")
    return 0
