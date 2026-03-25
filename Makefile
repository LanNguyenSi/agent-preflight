.PHONY: install build test lint check clean run batch sandbox-build sandbox install-cli release-bundle help

## Install dependencies
install:
	npm ci

## Install preflight into ~/.local/bin from the local checkout
install-cli:
	./install.sh

## Create a release bundle tarball in out/release
release-bundle:
	./scripts/create-release-bundle.sh

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

## Build the sandbox image with common runtimes and act preinstalled
sandbox-build:
	docker build -t agent-preflight:local .

## Run preflight inside the sandbox image (usage: make sandbox ARGS='-- --json')
sandbox: sandbox-build
	./agent-preflight-sandbox $(ARGS)

## Clean build artifacts
clean:
	rm -rf dist

## Show available commands
help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
	@echo ""
	@echo "Examples:"
	@echo "  make setup              # Install + build"
	@echo "  make install-cli        # Install preflight into ~/.local/bin"
	@echo "  make release-bundle     # Create a release bundle tarball"
	@echo "  make run                # Check current directory"
	@echo "  make batch DIR=~/git    # Check all repos in ~/git"
	@echo "  make sandbox            # Run preflight in the sandbox image"
	@echo "  node dist/cli.js run . --json  # JSON output for agents"
