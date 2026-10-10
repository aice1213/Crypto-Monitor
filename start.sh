#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
export NODE_ENV=development

npm run build --workspace=packages/shared
npm run build --workspace=packages/indicators
npm run dev:web
