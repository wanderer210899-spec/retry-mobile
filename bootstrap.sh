#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/wanderer210899-spec/retry-mobile.git"
# BOOTSTRAP_BRANCH: the default branch cloned when no argument or env var is supplied.
# Update this string whenever the canonical release branch is renamed or merged to main.
BOOTSTRAP_BRANCH="feature/screen_off_initial_generation"
REPO_BRANCH="${1:-${RETRY_MOBILE_BRANCH:-$BOOTSTRAP_BRANCH}}"
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
if [ -r /dev/tty ]; then
  RETRY_MOBILE_BRANCH="$REPO_BRANCH" node "$REPO_DIR/install.cjs" < /dev/tty
else
  echo "Retry Mobile installer requires interactive terminal input (/dev/tty was not available)."
  exit 1
fi
