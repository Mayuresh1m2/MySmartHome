#!/usr/bin/env bash
# Shows every local log and audit line for one requestId, in time order, across skill, broker, rule and hub.
# Usage: scripts/trace.sh <requestId>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID="${1:?usage: scripts/trace.sh <requestId>}"
files=()
for f in "$ROOT"/local-stack/.state/logs/*.log "$ROOT"/local-stack/.state/audit/*.jsonl "$ROOT"/hearth-hub/data/audit/*.jsonl; do
  [ -e "$f" ] && files+=("$f")
done
[ ${#files[@]} -gt 0 ] || { echo "no logs found"; exit 1; }
grep -h -F "$ID" "${files[@]}" | grep '^{' | jq -c -s '
  sort_by(.ts // .time) | .[] |
  {t: ((.ts // .time) | tostring | .[11:23]),
   src: (.svc // (if .decision then "hub-audit" else "?" end)),
   what: (.msg // .evt // .decision),
   outcome: (.outcome // null), latencyMs: (.latencyMs // null), stages: (.stages // null),
   tool: (.tool // null), topic: (.topic // null)} | with_entries(select(.value != null))'
