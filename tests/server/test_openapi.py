# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
from pathlib import Path

import pytest

from agentprof.server.openapi import main, openapi_schema


def test_openapi_schema_describes_the_api_but_not_the_frontend_route() -> None:
    schema = openapi_schema()

    assert "/api/sessions" in schema["paths"]
    assert "/api/sessions/{session_id}" in schema["paths"]
    assert "NodeOut" in schema["components"]["schemas"]
    assert "/{path}" not in schema["paths"]


def test_projected_session_is_described_with_omitted_children() -> None:
    schema = openapi_schema()
    response = schema["paths"]["/api/sessions/{session_id}"]["get"]["responses"]["200"]["content"]["application/json"][
        "schema"
    ]

    assert {item["$ref"] for item in response["anyOf"]} == {
        "#/components/schemas/SessionOut",
        "#/components/schemas/ProjectedSessionOut",
    }
    projected = schema["components"]["schemas"]["ProjectedNodeOut"]
    assert "children_omitted" in projected["properties"]


def test_main_writes_the_schema(tmp_path: Path) -> None:
    output = tmp_path / "openapi.json"

    assert main([str(output)]) == 0

    assert json.loads(output.read_text(encoding="utf-8"))["openapi"].startswith("3.")


def test_main_requires_one_output_path(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 2
    assert "usage" in capsys.readouterr().err
