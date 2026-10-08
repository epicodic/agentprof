# AGENTS.md

Instructions for agentic workers (OpenAI Codex, Claude Code, GitHub Copilot agents, etc.).
This file is also served as `CLAUDE.md` via symlink for Claude Code.

---

## Shared Rules

**Read [`.agents/AGENTS.md`](.agents/AGENTS.md) before anything else.**
It holds the rules shared by all projects: approval rules, reading and writing documentation, `uv` usage, Serena, communication style, private development files (`.devkit/`), and the skills.
It is private tooling that is linked in locally; if it is missing, ignore this section.

@.agents/AGENTS.md

---

## Project Overview

agentprof is a local web app that analyses AI coding agent sessions: call trees, timings, tokens, cost and waste.
Read `docs/architecture.md` before changing or extending the code: it covers the repository layout, the components, the data flow and recipes for common extensions.

---

## Platform

| Item | Value |
|------|-------|
| Python version | 3.12 |

---

## Setup

Run ./bootstrap.sh once to install uv, Node (via nvm), pnpm and all dependencies; afterwards no setup step is needed before running commands.

---

## Commands

### Run the app

```sh
uv run agentprof                 # run the app via the installed script entry point
```

### Tests

```sh
uv run pytest                                  # run all tests
uv run pytest tests/test_archives.py           # run a specific test file
uv run pytest tests/test_archives.py::test_foo # run a specific test
```

### Frontend

```sh
pnpm --dir frontend dev        # Vite dev server; proxies /api to `uv run agentprof` on port 8765
pnpm --dir frontend build      # build into src/agentprof/server/static/
pnpm --dir frontend gen:api    # regenerate src/api/schema.ts after changing server/schemas.py
pnpm --dir frontend e2e        # build and run the Playwright smoke test
```

### Quality Assurance (lint, type check, tests)

```sh
uv run qa                 # run all QA checks (lint, type check, tests)
uv run qa --fix           # run all QA checks and apply auto-fixes where possible
```

uv run qa also runs the frontend's lint, type check and unit tests when the frontend is set up.

Individual tools:

```sh
uv run ruff check .       # lint
uv run ruff format .      # format
uv run ty check .         # type check
```

Always run `uv run qa` after changes and confirm zero failures before claiming work is complete.

### Distribution

```sh
uv run build-dist         # build frontend, wheel and sdist into dist/, check them, smoke-test the wheel
uv run smoke dist         # smoke-test an already built wheel
```

---

## Coding Conventions

Full reference: `docs/coding_conventions.md`

