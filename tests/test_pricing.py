# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
from pathlib import Path

import pytest

from agentprof.model import CostMetric, Provenance
from agentprof.pricing import ModelPrice, PriceTable, Usage


def _usage(**counts: int) -> Usage:
    return Usage(**{"input": 0, "output": 0, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0, **counts})


def test_bundled_table_prices_a_known_model_as_estimated_usd() -> None:
    cost = PriceTable.load().cost("claude-sonnet-5", _usage(input=100, output=40, cache_read=1000, cache_write_5m=500))

    assert cost.unit == "USD"
    assert cost.provenance is Provenance.ESTIMATED
    assert cost.value == pytest.approx(0.00205)


def test_bundled_table_prices_one_hour_cache_writes_at_twice_the_input_rate() -> None:
    cost = PriceTable.load().cost("claude-haiku-4-5-20251001", _usage(cache_write_1h=1_000_000))

    assert cost.value == pytest.approx(2.0)


@pytest.mark.parametrize(
    ("model", "price"),
    [
        ("gpt-6-astra", ModelPrice(input=10.0, output=50.0, cache_read=1.0, cache_write_5m=12.5, cache_write_1h=20.0)),
        ("gpt-6-sol", ModelPrice(input=2.0, output=10.0, cache_read=0.2, cache_write_5m=2.5, cache_write_1h=4.0)),
        ("gpt-6-luna", ModelPrice(input=0.1, output=0.5, cache_read=0.01, cache_write_5m=0.125, cache_write_1h=0.2)),
        ("gpt-5.6-terra", ModelPrice(input=2.0, output=12.0, cache_read=0.2, cache_write_5m=2.5, cache_write_1h=4.0)),
    ],
)
def test_bundled_table_has_codex_model_prices(model: str, price: ModelPrice) -> None:
    assert PriceTable.load().price_for(f"{model}-2026-09-01") == price


def test_longest_prefix_wins() -> None:
    table = PriceTable.load()

    assert table.price_for("claude-opus-5-5") == ModelPrice(
        input=4.0, output=20.0, cache_read=0.2, cache_write_5m=5.0, cache_write_1h=8.0
    )
    assert table.price_for("claude-opus-5") == ModelPrice(
        input=5.0, output=25.0, cache_read=0.5, cache_write_5m=6.25, cache_write_1h=10.0
    )


def test_unknown_or_missing_model_costs_are_not_available() -> None:
    table = PriceTable.load()

    assert table.cost("claude-unknown-9", _usage(input=1)) == CostMetric.not_available()
    assert table.cost(None, _usage(input=1)) == CostMetric.not_available()


def test_synthetic_messages_cost_nothing() -> None:
    assert PriceTable.load().cost("<synthetic>", _usage(input=5)).value == 0.0


def test_a_price_file_replaces_the_bundled_table(tmp_path: Path) -> None:
    path = tmp_path / "prices.json"
    path.write_text(
        json.dumps(
            {
                "models": {
                    "my-model": {"input": 1, "output": 2, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0}
                }
            }
        )
    )

    table = PriceTable.load(path)

    assert table.cost("my-model-v2", _usage(output=1_000_000)).value == pytest.approx(2.0)
    assert table.price_for("claude-sonnet-5") is None


def test_bundled_table_values_a_credit_at_one_cent() -> None:
    assert PriceTable.load().usd_per_credit == 0.01


def test_a_price_file_sets_the_credit_rate(tmp_path: Path) -> None:
    path = tmp_path / "prices.json"
    path.write_text(json.dumps({"usd_per_credit": 0.02, "models": {}}))

    assert PriceTable.load(path).usd_per_credit == 0.02


def test_bundled_table_exposes_effective_metadata_and_models() -> None:
    table = PriceTable.load()

    assert table.source == "Anthropic API list prices, 2026-06-24"
    assert table.date == "2026-06-24"
    assert table.models["claude-sonnet-5"] == table.price_for("claude-sonnet-5-2026")


def test_custom_table_exposes_supplied_metadata_and_models(tmp_path: Path) -> None:
    path = tmp_path / "prices.json"
    path.write_text(
        json.dumps(
            {
                "source": "Example price list",
                "date": "2026-10-02",
                "models": {
                    "example": {"input": 1, "output": 2, "cache_read": 3, "cache_write_5m": 4, "cache_write_1h": 5}
                },
            }
        )
    )

    table = PriceTable.load(path)

    assert table.source == "Example price list"
    assert table.date == "2026-10-02"
    assert table.models == {"example": ModelPrice(1, 2, 3, 4, 5)}


def test_custom_table_without_metadata_keeps_it_absent(tmp_path: Path) -> None:
    path = tmp_path / "prices.json"
    path.write_text(json.dumps({"models": {}}))

    table = PriceTable.load(path)

    assert table.source is None
    assert table.date is None


def test_matching_prefix_uses_the_longest_matching_entry() -> None:
    table = PriceTable.load()

    assert table.matching_prefix("claude-opus-5-5-2026") == "claude-opus-5-5"
    assert table.matching_prefix("claude-opus-5-2026") == "claude-opus-5"
    assert table.matching_prefix("unknown") is None
    assert table.matching_prefix(None) is None


def test_cost_parts_returns_estimated_usd_for_each_token_kind() -> None:
    table = PriceTable.load()

    parts = table.cost_parts("claude-sonnet-5-2026", _usage(input=1_000_000, output=2_000_000, cache_read=3_000_000))

    assert parts == {
        "input": CostMetric(value=2.0, unit="USD", provenance=Provenance.ESTIMATED),
        "output": CostMetric(value=20.0, unit="USD", provenance=Provenance.ESTIMATED),
        "cache_read": CostMetric(value=0.6, unit="USD", provenance=Provenance.ESTIMATED),
        "cache_write_5m": CostMetric(value=0.0, unit="USD", provenance=Provenance.ESTIMATED),
        "cache_write_1h": CostMetric(value=0.0, unit="USD", provenance=Provenance.ESTIMATED),
    }
    assert sum(part.value for part in parts.values() if part.value is not None) == pytest.approx(
        table.cost("claude-sonnet-5-2026", _usage(input=1_000_000, output=2_000_000, cache_read=3_000_000)).value
    )


def test_cost_parts_for_unknown_model_are_unavailable() -> None:
    parts = PriceTable.load().cost_parts("unknown", _usage(input=1))

    assert set(parts) == {"input", "output", "cache_read", "cache_write_5m", "cache_write_1h"}
    assert all(part == CostMetric.not_available() for part in parts.values())
