#!/usr/bin/env bash
set -euo pipefail

dprint fmt
oxlint -c oxlintrc.json src/
tsgo -p . --noEmit
bun test src/__tests__/index.test.ts src/__tests__/runDevRunner.test.ts
