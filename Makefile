# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
#
# Shortcuts for the commands in AGENTS.md. Run `make` or `make help` for the list.

# Put the nvm Node pinned in .nvmrc (and its corepack pnpm) on PATH, so frontend targets
# work in shells that have not loaded nvm.
NVM_DIR ?= $(HOME)/.nvm
NODE_BIN := $(shell ls -d $(NVM_DIR)/versions/node/v$(shell cat .nvmrc).*/bin 2>/dev/null | sort -V | tail -n 1)
ifneq ($(NODE_BIN),)
export PATH := $(NODE_BIN):$(PATH)
endif

PNPM := pnpm --dir frontend

.DEFAULT_GOAL := help

.PHONY: help bootstrap run dev test qa fix lint format typecheck build gen-api e2e dist smoke clean

help: ## Show this help
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

bootstrap: ## Install uv, Node, pnpm and all dependencies
	./bootstrap.sh

run: ## Run the app
	uv run agentprof

dev: ## Run the Vite dev server (start `make run` alongside)
	$(PNPM) dev

test: ## Run the Python tests
	uv run pytest

qa: ## Run all QA checks (lint, type check, tests)
	uv run qa

fix: ## Run all QA checks and apply auto-fixes
	uv run qa --fix

lint: ## Lint the Python code
	uv run ruff check .

format: ## Format the Python code
	uv run ruff format .

typecheck: ## Type-check the Python code
	uv run ty check .

build: ## Build the frontend into the server's static directory
	$(PNPM) build

gen-api: ## Regenerate the frontend API types from server/schemas.py
	$(PNPM) gen:api

e2e: ## Build the frontend and run the Playwright smoke test
	$(PNPM) e2e

dist: ## Build and smoke-test the wheel and sdist into dist/
	uv run build-dist

smoke: ## Smoke-test an already built wheel in dist/
	uv run smoke dist

clean: ## Remove build output and caches
	rm -rf dist .pytest_cache .ruff_cache
