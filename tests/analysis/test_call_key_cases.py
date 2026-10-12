# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""The shared key cases that the frontend's test helper `withCallKeys` must reproduce too."""

import json
from pathlib import Path

import pytest

from agentprof.analysis.identity import call_keys
from agentprof.model import LlmCall, Metric, Provenance

_CASES = json.loads((Path(__file__).parents[2] / "frontend" / "src" / "test" / "callKeyCases.json").read_text())


def _call(spec: dict) -> LlmCall:
    start = Metric.not_available() if spec["start"] is None else Metric(spec["start"], Provenance(spec["provenance"]))
    return LlmCall(start=start, call_id=spec["call_id"])


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_call_keys_match_the_shared_cases(case: dict) -> None:
    assert call_keys([_call(spec) for spec in case["calls"]]) == case["keys"]
