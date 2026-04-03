#!/usr/bin/env bash
set -euo pipefail

bun run format:check
bun run lint
bun run typecheck
bun run test
