# Coding Conventions

The backend is Python 3.12; the frontend in `frontend/` is TypeScript with React.

## Python

- **Formatter / linter:** `ruff` (120-char line length, 4-space indent)
- **Type checking:** `uv run ty check .`
- All functions and methods must have **full type annotations** 
- Use `X | None` — not `Optional[X]`
- Use builtin collection types: `list`, `dict`, `set`, `tuple` — not `typing.List` etc.

### Naming

- `snake_case` — functions, variables, members
- `UpperCamelCase` — types, classes
- `_` prefix — private names
- `UPPER_CASE` — constants

### Docstrings

Google style; encouraged for public API; multiline docstrings start immediately after `"""` (no blank line).

## TypeScript and React

- **Formatter / linter:** Biome (`pnpm --dir frontend lint`), 2-space indent, 120-char lines, recommended rules.
- **Type checking:** `pnpm --dir frontend typecheck` (`strict`, no unused locals or parameters).
- Every `.ts` and `.tsx` file except the generated `src/api/schema.ts` starts with the SPDX header used in the Python files, as `//` comments.
- Named exports only; default exports appear only in the tool configs (`vite.config.ts`, `playwright.config.ts`, `vitest.global-setup.ts`).
- `camelCase` for functions and variables, `PascalCase` for components, types and interfaces, `UPPER_CASE` for module-level constants.
- Hooks are named `useXxx`; session-view state hooks live in `src/hooks/` with their decisions in `src/lib/`, query hooks in `src/api/hooks.ts`.
- Pure logic goes into `src/lib/<name>.ts`, tested in `src/lib/<name>.test.ts`; components do layout and wiring.
- API types come from the generated `src/api/schema.ts` (`pnpm --dir frontend gen:api`); never edit it by hand.
- Stable `data-testid`s are listed in `session-view.md`; keep them when changing markup.

### Frontend tests

- Unit tests: Vitest in a Node environment without a DOM (`pnpm --dir frontend test`), as `src/**/*.test.ts` next to the code.
- Test pure functions and reducers; render components with `renderToStaticMarkup` where markup matters.
- End to end: Playwright (`pnpm --dir frontend e2e`) against the real app on the test fixtures.

## Testing

- Framework: **pytest**
- Test files: `test_*.py` in `tests/`
- All test functions fully type-annotated
- Run one test: `uv run pytest tests/path/test_module.py::test_name -v`
- Run all tests: `uv run pytest`
- Lint: `uv run ruff check .`
- Format: `uv run ruff format .`
- All QA checks: `uv run qa`
