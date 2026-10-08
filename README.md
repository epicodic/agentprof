# agentprof

[![PyPI](https://img.shields.io/pypi/v/agentprof?cacheSeconds=3600)](https://pypi.org/project/agentprof/)
[![Python versions](https://img.shields.io/pypi/pyversions/agentprof?cacheSeconds=3600)](https://pypi.org/project/agentprof/)
[![CI](https://github.com/epicodic/agentprof/actions/workflows/ci.yml/badge.svg)](https://github.com/epicodic/agentprof/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/epicodic/agentprof/blob/main/LICENSE)

**A profiler for AI coding agents: see where your agents spend time, tokens and money.**

agentprof reads the session logs that Claude Code, OpenAI Codex CLI and VS Code Copilot Chat already write on your machine.
It shows each session as a call tree of turns, subagents and tool calls, with an inline timeline, token counts, context growth, costs and hints about likely waste.
Everything runs locally, so your sessions never leave your machine.

![A Claude Code session as a call tree with timeline, cost, tokens and context per row](https://media.githubusercontent.com/media/epicodic/agentprof/main/docs/images/session-tree.png)

## Features

- **Call tree with timeline**: every prompt, subagent and tool call becomes a row with its duration, cost, tokens and peak context, next to a timeline bar for when it ran.
  Nested subagents get their own colour-coded agent numbers, so you can follow a delegation chain at a glance.
- **Cost and token accounting**: costs and tokens are given both per node and rolled up per subtree, with input, output, cache read and cache write tokens counted separately.
  Estimated values are marked `≈`, and values the logs do not contain are shown as `–` instead of being guessed.
- **Context tracking**: see how the context window grows call by call, where it peaks and where it was compacted.
- **Agent summary**: one row per agent with its model, cache TTL, resumes, duration, own cost, share of the session cost and token breakdown.
- **Node details**: open any turn or agent to see its timeline, cost per LLM call, context chart, subagents and a searchable list of LLM and tool calls, down to the raw prompt, result and tool arguments.
- **Waste findings**: hints, not verdicts, about where time and money may have gone (see [Findings](#findings)).
- **Live updates**: the session list fills in within seconds, and open sessions update while an agent is still working.
- **Local JSON API**: everything in the UI is also available as JSON, so you can script your own reports.

![Node details with timeline, cost per LLM call, context growth, subagents and LLM calls](https://media.githubusercontent.com/media/epicodic/agentprof/main/docs/images/node-details.png)

## Installation

agentprof is a command-line tool that starts a local web app.
Install it in its own isolated environment with [uv](https://docs.astral.sh/uv/) or [pipx](https://pipx.pypa.io/):

```sh
uv tool install agentprof
# or
pipx install agentprof
```

Or run it once without installing it:

```sh
uvx agentprof
```

agentprof requires Python 3.12 or newer.

## Usage

```sh
agentprof
```

This starts a local server on `127.0.0.1:8765` and opens your browser.
The session list appears immediately and fills in while sessions are summarised in the background; a session is analysed in full when you open it.

```
agentprof [SESSION] [--host 127.0.0.1] [--port 8765] [--no-browser]
          [--claude-root DIR] [--codex-root DIR] [--copilot-root DIR]
          [--pricing FILE]
```

| Option | Purpose |
|---|---|
| `SESSION` | Open a session directly: `<agent>:<id>` (e.g. `claude-code:<id>`), a bare id, or a session file path such as a Copilot chat export. |
| `--host`, `--port` | Interface and port to bind. |
| `--no-browser` | Do not open a browser. |
| `--claude-root`, `--codex-root`, `--copilot-root` | Read sessions from a different directory. |
| `--pricing` | Replace the bundled price table: per-model token prices and the USD value of a Copilot credit (`usd_per_credit`). |

## Supported agents

| Agent | Sessions read from | Cost |
|---|---|---|
| Claude Code | `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`), including subagent transcripts | USD at API list prices, estimated |
| OpenAI Codex CLI | `~/.codex/sessions`, including subagent rollouts | USD at API list prices, estimated |
| VS Code Copilot Chat | `workspaceStorage` of VS Code and VS Code Insiders on Linux, macOS and Windows | Credits as reported by Copilot, converted to USD at $0.01 per credit |

Claude Code and Codex costs are API-equivalent estimates; on a subscription you do not pay per token.
Costs keep their native unit and are never added across units.

## Findings

agentprof flags likely waste as hints, not verdicts.
Each finding is attached to the turn or agent it is about, and the session header counts them.

| Finding | What it looks for |
|---|---|
| Repeated reads | The same file read several times with overlapping line ranges. |
| Re-acquired context | A subagent reading files its parent agent had already read. |
| Retry chains | Sibling agents started with very similar tasks. |
| Repeated or failing commands | The same command run again and again, or a high tool failure rate. |
| Polling loops | Long streaks of consecutive polling calls. |
| Cost outliers | Agents that cost far more than their siblings. |
| Context bloat | Large uncached prompts and low cache hit ratios. |
| Cold cache rewrites | Large cache writes with little reuse, for example after the cache expired during a wait for the user. |
| Idle parents | A parent agent idling after a child agent completed. |
| Context jumps | Context that grew sharply between two calls. |

## Local API

While agentprof runs, its data is available as JSON on the same port:

| Endpoint | Returns |
|---|---|
| [`/api`](http://127.0.0.1:8765/api/) | Endpoint index with parameters and descriptions |
| [`/docs`](http://127.0.0.1:8765/docs) | Interactive OpenAPI schema |
| `/api/sessions` | All sessions, newest first |
| `/api/sessions/events` | Server-sent events for session list updates |
| `/api/sessions/{id}` | The full call tree with metrics and findings; `depth` and `fields=session,diagnostics,tree` bound a large download |
| `/api/sessions/{id}/summary` | One compact row per agent, with cost and cache breakdowns |
| `/api/sessions/{id}/findings` | Findings, ordered by estimated avoidable cost, severity and time |
| `/api/sessions/{id}/diagnostics` | Parse counts and redacted details of malformed lines |
| `/api/pricing` | The effective price table and its model matching rule |

## Development

```sh
./bootstrap.sh             # install uv, Node (nvm), pnpm and all dependencies
uv run agentprof           # run against your own sessions
pnpm --dir frontend dev    # frontend dev server, proxies /api to port 8765
uv run qa                  # lint, type check and tests for Python and the frontend
uv run build-dist          # build and smoke-test the distributions
```

See [`docs/architecture.md`](https://github.com/epicodic/agentprof/blob/main/docs/architecture.md) for how the code fits together, [`AGENTS.md`](https://github.com/epicodic/agentprof/blob/main/AGENTS.md) for conventions and [`docs/releasing.md`](https://github.com/epicodic/agentprof/blob/main/docs/releasing.md) for releases.

## License

[MIT](https://github.com/epicodic/agentprof/blob/main/LICENSE)
