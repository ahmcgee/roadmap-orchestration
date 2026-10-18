#!/usr/bin/env bash
# Browser tooling for walkthrough sessions and the walkthrough role evals: the Playwright MCP server and the
# Chromium build its bundled Playwright expects, with Chromium's system libraries. The executor itself pins nothing:
# a consumer's environment may provide any Playwright MCP version; this repo pins one for reproducible evals.
set -euo pipefail
PLAYWRIGHT_MCP_VERSION=0.0.83
npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"
cli="$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js"
sudo env "PATH=$PATH" node "$cli" install-deps chromium
node "$cli" install chromium
