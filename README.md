# agentprof

See where your AI coding agents spend time, tokens and money.

agentprof reads the session logs that VS Code Copilot Chat and Claude Code write on your machine and shows every session as a call tree of turns, subagents and tool calls, with an inline timeline, token counts, costs and waste findings.
Everything runs locally; your sessions never leave your machine.

![A session in agentprof](docs/images/session-view.png)

## Install and run

```sh
uvx agentprof            # or: pipx install agentprof && agentprof
```

agentprof starts a local server on `127.0.0.1:8765` and opens your browser.
The session list appears immediately and fills in while sessions are summarised in the background (a session is analysed when you open it); open sessions update live while an agent is still working.

```
agentprof [SESSION|PATH] [--host 127.0.0.1] [--port 8765] [--no-browser]
            [--copilot-root DIR] [--claude-root DIR] [--pricing FILE]
```

- `SESSION` opens a session directly: `claude-code:<id>`, a bare id, or a session file path (e.g. a Copilot chat export).
- `--copilot-root` and `--claude-root` override where sessions are read from.
- `--pricing` replaces the bundled price table: the Claude Code token prices and the USD value of a Copilot credit (`usd_per_credit`).

## Supported agents

| Agent | Sessions read from | Cost |
|---|---|---|
| VS Code Copilot Chat | `workspaceStorage` of VS Code and VS Code Insiders (Linux, macOS, Windows) | Credits, as reported by Copilot, converted to USD at $0.01 per credit |
| Claude Code | `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) | USD at API list prices, estimated |

Claude Code costs are API-equivalent estimates; on a subscription you do not pay per token.
Values marked `≈` are estimates, `–` means the logs do not contain the number.

## Local API

Open [`/api`](http://127.0.0.1:8765/api/) for the endpoint index, or [`/docs`](http://127.0.0.1:8765/docs) for the interactive schema.
`/api/sessions` lists sessions, and `/api/sessions/events` is a server-sent event stream for list updates; it takes no session parameter.
For one session, `/api/sessions/{id}/summary` gives compact agent metrics, while `/findings` and `/diagnostics` suffixes provide focused evidence and parse quality.
The full `/api/sessions/{id}` response accepts `depth` and `fields=session,diagnostics,tree` to bound a large tree download.
`/api/pricing` reports the effective configured price table and its model matching rule.

## Findings

agentprof flags likely waste as hints, not verdicts: repeated reads of the same file, context re-read by subagents, retries of the same task, repeated or failing commands, polling loops, idle gaps, cost outliers among sibling agents, and large uncached prompts.

## Development

```sh
./bootstrap.sh             # installs uv, Node (nvm), pnpm and all dependencies
uv run qa                  # lint, type check and tests for Python and the frontend
uv run agentprof         # run against your own sessions
pnpm --dir frontend dev    # frontend dev server, proxies /api to port 8765
uv run build-dist          # build and smoke-test the distributions
```

See `AGENTS.md` for conventions and `docs/releasing.md` for releases.

## License

MIT
