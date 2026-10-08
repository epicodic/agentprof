# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import agentprof


def test_package_exposes_its_version() -> None:
    assert agentprof.__version__ == "0.1.0"
