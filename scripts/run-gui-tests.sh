#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="/home/dataset-local/data1/env/.nvm/versions/node/v24.14.0/bin"

export PATH="$NODE_BIN:$PATH"

USE_XVFB=0
if [[ "${1:-}" == "--xvfb" ]]; then
  USE_XVFB=1
  shift
fi

cd "$ROOT_DIR"

npm run compile

if [[ "$USE_XVFB" -eq 1 ]]; then
  exec xvfb-run -a node tests/gui/runGuiTests.js "$@"
fi

exec node tests/gui/runGuiTests.js "$@"
