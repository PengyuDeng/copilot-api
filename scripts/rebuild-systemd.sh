#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/copilot-api}"
SERVICE_NAME="${SERVICE_NAME:-copilot-api}"
OUTFILE="${OUTFILE:-dist/copilot-api}"
RUN_INSTALL="${RUN_INSTALL:-1}"
RUN_TESTS="${RUN_TESTS:-1}"
RUN_TYPECHECK="${RUN_TYPECHECK:-1}"

if [[ -z "${TARGET:-}" ]]; then
  case "$(uname -m)" in
    x86_64 | amd64)
      TARGET="bun-linux-x64"
      ;;
    aarch64 | arm64)
      TARGET="bun-linux-arm64"
      ;;
    *)
      echo "Unsupported architecture: $(uname -m). Set TARGET manually." >&2
      exit 1
      ;;
  esac
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed or not in PATH." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "APP_DIR does not exist: $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

if [[ ! -f src/main.ts ]]; then
  echo "src/main.ts not found in $APP_DIR" >&2
  exit 1
fi

if [[ "$RUN_INSTALL" == "1" ]]; then
  bun install --frozen-lockfile
fi

if [[ "$RUN_TESTS" == "1" ]]; then
  bun test
fi

if [[ "$RUN_TYPECHECK" == "1" ]]; then
  bun run typecheck
fi

bun build --compile --target="$TARGET" --outfile="$OUTFILE" src/main.ts
chmod +x "$OUTFILE"

if command -v systemctl >/dev/null 2>&1; then
  if [[ "$(id -u)" == "0" ]]; then
    systemctl restart "$SERVICE_NAME"
    systemctl --no-pager --full status "$SERVICE_NAME"
  else
    sudo systemctl restart "$SERVICE_NAME"
    sudo systemctl --no-pager --full status "$SERVICE_NAME"
  fi
else
  echo "systemctl not found. Built $OUTFILE but did not restart a service." >&2
fi
