# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.adapters.timestamps import parse_iso_ms

_T0 = 1789898400000  # 2026-09-20T10:00:00Z


def test_parse_iso_ms_reads_utc_suffix() -> None:
    assert parse_iso_ms("2026-09-20T10:00:00.250Z") == _T0 + 250


def test_parse_iso_ms_honours_an_offset() -> None:
    assert parse_iso_ms("2026-09-20T12:00:00+02:00") == _T0


def test_parse_iso_ms_reads_a_naive_timestamp_as_utc() -> None:
    assert parse_iso_ms("2026-09-20T10:00:00") == _T0
