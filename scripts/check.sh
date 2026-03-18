#!/usr/bin/env bash
set -euo pipefail

dprint fmt
oxlint -c oxlintrc.json src/
tsgo -p . --noEmit
