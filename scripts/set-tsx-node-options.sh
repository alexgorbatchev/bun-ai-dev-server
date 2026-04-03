#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${NODE_OPTIONS:-}" ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS} --import tsx"
else
  export NODE_OPTIONS="--import tsx"
fi
