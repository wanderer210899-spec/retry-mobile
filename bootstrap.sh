#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/wanderer210899-spec/retry-mobile.git"
# BOOTSTRAP_BRANCH: the default branch cloned when no CLI override or env var is supplied.
BOOTSTRAP_BRANCH="main"

print_usage() {
  cat <<'EOF'
Usage:
  curl -fsSL <bootstrap-url> | bash
  curl -fsSL <bootstrap-url> | bash -s -- <branch>
  curl -fsSL <bootstrap-url> | bash -s -- --branch <branch>

Override precedence:
  1. CLI branch argument
  2. RETRY_MOBILE_BRANCH environment variable
  3. main
EOF
}

resolve_branch() {
  if [ "$#" -eq 0 ]; then
    printf '%s\n' "${RETRY_MOBILE_BRANCH:-$BOOTSTRAP_BRANCH}"
    return 0
  fi

  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    -b|--branch)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "Retry Mobile bootstrap expected a branch name after $1." >&2
        exit 1
      fi
      printf '%s\n' "$2"
      return 0
      ;;
    *)
      printf '%s\n' "$1"
      return 0
      ;;
  esac
}

REPO_BRANCH="$(resolve_branch "$@")"
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
