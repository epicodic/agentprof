# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Timestamp parsing shared by adapters."""

from datetime import UTC, datetime


def parse_iso_ms(iso_timestamp: str) -> int:
    """Epoch milliseconds of an ISO 8601 timestamp; timestamps without an offset are taken as UTC."""
    parsed = datetime.fromisoformat(iso_timestamp)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp() * 1000)
