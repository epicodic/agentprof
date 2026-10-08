// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

// Render timestamps in UTC so tests do not depend on the machine's timezone.
export default function setup() {
  process.env.TZ = "UTC";
}
