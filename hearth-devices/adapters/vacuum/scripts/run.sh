#!/usr/bin/env bash
# Run a vacuum script with Dreamehome credentials injected from the gitignored
# env file, into the process environment only. Claude never reads this file;
# you populate it. Creds are not printed, not committed, not logged.
#
#   cp adapters/vacuum/secrets-template/dreame.env.example secrets/dreame.env
#   $EDITOR secrets/dreame.env        # set DREAME_USERNAME / DREAME_PASSWORD [/ DREAME_COUNTRY]
#   chmod 600 secrets/dreame.env
#   adapters/vacuum/scripts/run.sh login_probe.py
set -euo pipefail
ADAPTER="$(cd "$(dirname "$0")/.." && pwd)"
DEV_ROOT="$(cd "$ADAPTER/../.." && pwd)"          # hearth-devices/
ENV_FILE="$DEV_ROOT/secrets/dreame.env"
SCRIPT="${1:?usage: run.sh <script.py in scripts/> [args...]}"; shift || true

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE — create it from adapters/vacuum/secrets-template/dreame.env.example" >&2; exit 1; }
if [ "$(stat -c '%a' "$ENV_FILE")" != 600 ]; then
  echo "warning: $ENV_FILE is not mode 600; run: chmod 600 $ENV_FILE" >&2
fi

# Source creds into THIS shell's env only (auto-export), then hand off. No echo of values.
set -a; . "$ENV_FILE"; set +a

PY="$DEV_ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
exec "$PY" "$ADAPTER/scripts/$SCRIPT" "$@"
