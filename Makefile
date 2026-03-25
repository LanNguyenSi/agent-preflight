.PHONY: install build test lint check clean run batch help

## Install dependencies
install:
	npm ci

## Build TypeScript
build:
	npm run build

## Run tests
test:
	npx vitest run

## Typecheck without emit
check:
	npx tsc --noEmit --skipLibCheck

## Lint
lint:
	npx eslint src tests --ext .ts --fix || true

## Install + build in one step
setup: install build
	@echo "✅ agent-preflight ready. Run: node dist/cli.js run ."

## Run preflight on current directory
run: build
	node dist/cli.js run .

## Run preflight in batch mode on a directory (usage: make batch DIR=~/git)
batch: build
	node dist/cli.js batch $(DIR)

## Clean build artifacts
clean:
	rm -rf dist

## Show available commands
help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
	@echo ""
	@echo "Examples:"
	@echo "  make setup              # Install + build"
	@echo "  make run                # Check current directory"
	@echo "  make batch DIR=~/git    # Check all repos in ~/git"
	@echo "  node dist/cli.js run . --json  # JSON output for agents"
