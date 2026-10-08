# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Write the API's OpenAPI schema; the frontend generates its TypeScript types from it.

Run: `uv run python -m agentprof.server.openapi OUTPUT.json`
"""

import json
import sys
from pathlib import Path
from typing import Any

from agentprof.registry import Registry
from agentprof.server.app import create_app


def openapi_schema() -> dict[str, Any]:
    return create_app(Registry([])).openapi()


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m agentprof.server.openapi OUTPUT.json", file=sys.stderr)
        return 2
    Path(args[0]).write_text(json.dumps(openapi_schema(), indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
