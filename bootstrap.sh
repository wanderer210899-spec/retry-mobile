#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/wanderer210899-spec/retry-mobile.git"
REPO_BRANCH="main"
TEMP_ROOT="$(mktemp -d -t retry-mobile-installer-XXXXXX)"
REPO_DIR="$TEMP_ROOT/retry-mobile"
LAUNCH_DIRECTORY="$PWD"

cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

if ! command -v git >/dev/null 2>&1; then
  echo "Git is required to run the Retry Mobile bootstrap installer."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run the Retry Mobile bootstrap installer."
  exit 1
fi

git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
cd "$LAUNCH_DIRECTORY"
node "$REPO_DIR/install.cjs"
