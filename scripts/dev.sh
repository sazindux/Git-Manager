#!/usr/bin/env bash
# Local dev with fake GitHub (no credentials needed): ./scripts/dev.sh
cd "$(dirname "$0")/.."
export SESSION_SECRET="${SESSION_SECRET:-$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")}"
export GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-mock-client}"
export GITHUB_CLIENT_SECRET="${GITHUB_CLIENT_SECRET:-mock-secret}"
export GM_MOCK="${GM_MOCK:-1}"
export PORT="${PORT:-3000}"
exec node scripts/dev-server.js
