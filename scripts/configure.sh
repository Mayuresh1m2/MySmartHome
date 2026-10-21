#!/usr/bin/env bash
# One-time setup of the per-person settings in the repo-root .env (safe to rerun):
#   1. creates .env from .env.example if it doesn't exist (mode 600, gitignored)
#   2. with a signed-in AWS profile, fills HEARTH_IOT_ENDPOINT for HEARTH_AWS_REGION
#   3. validates everything and lists what is still missing
# Read-only towards AWS (sts get-caller-identity, iot describe-endpoint). Writes no credentials.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/env.sh"
ENVF="$(hearth_env_file)"
if [ ! -e "$ENVF" ]; then
  ( umask 077; cp "$ROOT/.env.example" "$ENVF" ) && echo "created $ENVF from .env.example. Fill in HEARTH_ALERT_EMAIL and check the rest"
fi
hearth_load_env

if command -v aws >/dev/null && [ -n "${HEARTH_AWS_REGION:-}" ]; then
  if acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null); then
    echo "AWS profile ${AWS_PROFILE:-default}: account ${acct:0:4}…${acct: -4}, region $HEARTH_AWS_REGION"
    ep=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --region "$HEARTH_AWS_REGION" --query endpointAddress --output text 2>&1) \
      || { echo "can't read the IoT endpoint in $HEARTH_AWS_REGION: $ep" >&2; echo "(new sign-up experience? check settings.aws.com → Project → Region)" >&2; ep=""; }
    if [ -n "$ep" ] && [ "${HEARTH_IOT_ENDPOINT:-}" != "$ep" ]; then
      hearth_set_env HEARTH_IOT_ENDPOINT "$ep"; export HEARTH_IOT_ENDPOINT="$ep"; echo "set HEARTH_IOT_ENDPOINT=$ep"
    fi
  else
    echo "AWS profile ${AWS_PROFILE:-default} isn't signed in (aws login --profile ${AWS_PROFILE:-hearth}); skipping the endpoint lookup"
  fi
fi

echo "checking settings…"
cd "$ROOT/hearth-aws" && npx tsx -e "
import('./lib/config.ts').then((m) => {
  const c = m.loadConfig(process.cwd());
  console.log('✔ all set: hub ' + c.hubId + ', region ' + c.region + ', locale ' + c.locale + ', kill switches \$' + c.hearthKillSwitchUsd + ' / \$' + c.accountKillSwitchUsd);
}).catch((e) => { console.log(e.message); process.exit(1); });"
