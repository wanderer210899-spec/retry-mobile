#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/wanderer210899-spec/retry-mobile.git"
# BOOTSTRAP_BRANCH: the default branch cloned when no CLI override or env var is supplied.
BOOTSTRAP_BRANCH="main"
HEADLESS_INSTALL=0
ST_ROOT_OVERRIDE="${RETRY_MOBILE_ST_ROOT:-}"

print_usage() {
  cat <<'EOF'
Usage:
  curl -fsSL <bootstrap-url> | bash
  curl -fsSL <bootstrap-url> | bash -s -- <branch>
  curl -fsSL <bootstrap-url> | bash -s -- --branch <branch>
  curl -fsSL <bootstrap-url> | bash -s -- --branch <branch> --headless
  curl -fsSL <bootstrap-url> | bash -s -- --branch <branch> --headless --st-root "$HOME/SillyTavern"

Override precedence:
  1. CLI branch argument
  2. RETRY_MOBILE_BRANCH environment variable
  3. main

Options:
  --headless          Non-interactive install/update. Installs backend plus global frontend.
  --st-root <path>    Explicit SillyTavern root. Defaults to current directory, ./SillyTavern,
                      or ~/SillyTavern on Termux when available.
EOF
}

parse_args() {
  local branch=""

  while [ "$#" -gt 0 ]; do
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
        branch="$2"
        shift 2
        ;;
      --headless)
        HEADLESS_INSTALL=1
        shift
        ;;
      --st-root)
        if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
          echo "Retry Mobile bootstrap expected a SillyTavern path after $1." >&2
          exit 1
        fi
        ST_ROOT_OVERRIDE="$2"
        shift 2
        ;;
      --)
        shift
        ;;
      -*)
        echo "Retry Mobile bootstrap does not recognize option: $1" >&2
        exit 1
        ;;
      *)
        if [ -n "$branch" ]; then
          echo "Retry Mobile bootstrap received multiple branch values: '$branch' and '$1'." >&2
          exit 1
        fi
        branch="$1"
        shift
        ;;
    esac
  done

  if [ -z "$branch" ]; then
    branch="${RETRY_MOBILE_BRANCH:-$BOOTSTRAP_BRANCH}"
  fi

  printf '%s\n' "$branch"
}

resolve_launch_directory() {
  if [ -n "${ST_ROOT_OVERRIDE:-}" ]; then
    printf '%s\n' "$ST_ROOT_OVERRIDE"
    return 0
  fi

  if [ -f "$PWD/config.yaml" ]; then
    printf '%s\n' "$PWD"
    return 0
  fi

  if [ -f "$PWD/SillyTavern/config.yaml" ]; then
    printf '%s\n' "$PWD/SillyTavern"
    return 0
  fi

  if [ -n "${HOME:-}" ] && [ -f "$HOME/SillyTavern/config.yaml" ]; then
    printf '%s\n' "$HOME/SillyTavern"
    return 0
  fi

  printf '%s\n' "$PWD"
}

REPO_BRANCH="$(parse_args "$@")"
TEMP_ROOT="$(mktemp -d -t retry-mobile-installer-XXXXXX)"
REPO_DIR="$TEMP_ROOT/retry-mobile"
LAUNCH_DIRECTORY="$(resolve_launch_directory)"

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

if [ "$HEADLESS_INSTALL" -eq 1 ]; then
  RETRY_MOBILE_HEADLESS=1 RETRY_MOBILE_BRANCH="$REPO_BRANCH" node "$REPO_DIR/install.cjs"
elif [ -r /dev/tty ]; then
  RETRY_MOBILE_BRANCH="$REPO_BRANCH" node "$REPO_DIR/install.cjs" < /dev/tty
else
  echo "Retry Mobile installer requires interactive terminal input (/dev/tty was not available)."
  exit 1
fi
