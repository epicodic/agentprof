# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import io
import tarfile
import zipfile
from pathlib import Path

from agentprof_qa.build_dist import check_sdist, check_wheel, project_version

_COMPLETE_WHEEL = [
    "agentprof/server/static/index.html",
    "agentprof/server/static/assets/index-abc.js",
    "agentprof/pricing.json",
]


def _wheel(directory: Path, version: str, names: list[str]) -> Path:
    path = directory / f"agentprof-{version}-py3-none-any.whl"
    with zipfile.ZipFile(path, "w") as archive:
        for name in names:
            archive.writestr(name, "x")
    return path


def _sdist(directory: Path, version: str, names: list[str]) -> Path:
    path = directory / f"agentprof-{version}.tar.gz"
    with tarfile.open(path, "w:gz") as archive:
        for name in names:
            info = tarfile.TarInfo(f"agentprof-{version}/{name}")
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
    return path


def test_project_version_reads_pyproject(tmp_path: Path) -> None:
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text('[project]\nname = "agentprof"\nversion = "1.2.3"\n', encoding="utf-8")

    assert project_version(pyproject) == "1.2.3"


def test_check_wheel_accepts_a_complete_wheel(tmp_path: Path) -> None:
    assert check_wheel(_wheel(tmp_path, "0.1.0", _COMPLETE_WHEEL), "0.1.0") == []


def test_check_wheel_reports_missing_frontend_and_wrong_version(tmp_path: Path) -> None:
    problems = check_wheel(_wheel(tmp_path, "0.1.0", ["agentprof/pricing.json"]), "0.2.0")

    assert any("0.2.0" in problem for problem in problems)
    assert any("index.html" in problem for problem in problems)
    assert any("assets" in problem for problem in problems)


def test_check_sdist_requires_the_built_frontend(tmp_path: Path) -> None:
    good = _sdist(tmp_path, "0.1.0", ["src/agentprof/server/static/index.html"])
    assert check_sdist(good, "0.1.0") == []

    bad_dir = tmp_path / "bad"
    bad_dir.mkdir()
    bad = _sdist(bad_dir, "0.1.0", ["src/agentprof/cli.py"])
    assert check_sdist(bad, "0.1.0") == ["sdist lacks src/agentprof/server/static/index.html"]
