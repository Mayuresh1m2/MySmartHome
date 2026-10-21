#!/usr/bin/env bash
# Hand the hub its identity after a deploy: fetches the certificate PEM issued from the hub's CSR and writes
#   out/hub.crt   (or out/hub-<name>.crt for a non-primary certificate during rotation)
#   out/hub.env   IOT_ENDPOINT, HUB_ID, AWS_REGION
# Settings from the repo-root .env. Uses the AWS CLI profile (AWS_PROFILE). Writes no credentials.
# The hub's private key is never involved.
# Usage: scripts/handoff.sh [certificate-name]      (default: primary)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/../scripts/env.sh"
hearth_load_env
OUT="${OUT_DIR:-$ROOT/out}"
REGION="${HEARTH_AWS_REGION:?set HEARTH_AWS_REGION in .env}"
NAME="${1:-primary}"

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }
HUB_ID="${HEARTH_HUB_ID:-laptop}"
ENDPOINT="${HEARTH_IOT_ENDPOINT:?set HEARTH_IOT_ENDPOINT in .env (scripts/configure.sh)}"
STACK="Hearth-$HUB_ID"
SUFFIX=$([ "$NAME" = primary ] && echo "" || echo "$NAME")

CERT_ID=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='HubCertificateId$SUFFIX'].OutputValue" --output text)
if [ -z "$CERT_ID" ] || [ "$CERT_ID" = "None" ]; then
  echo "stack $STACK has no output HubCertificateId$SUFFIX (certificate '$NAME' deployed?)" >&2; exit 1
fi

ACTUAL_ENDPOINT=$(aws iot describe-endpoint --region "$REGION" --endpoint-type iot:Data-ATS --query endpointAddress --output text)
if [ "$ACTUAL_ENDPOINT" != "$ENDPOINT" ]; then
  echo "config iotEndpoint ($ENDPOINT) differs from this account's ATS endpoint ($ACTUAL_ENDPOINT)" >&2; exit 1
fi

DESC=$(aws iot describe-certificate --region "$REGION" --certificate-id "$CERT_ID" --output json)
STATUS=$(jq -r .certificateDescription.status <<<"$DESC")
PEM=$(jq -r .certificateDescription.certificatePem <<<"$DESC")
grep -q "BEGIN CERTIFICATE" <<<"$PEM" || { echo "describe-certificate returned no PEM" >&2; exit 1; }
if grep -q "PRIVATE KEY" <<<"$PEM"; then echo "refusing: response contains a private key" >&2; exit 1; fi

mkdir -p "$OUT"
CRT="$OUT/$([ "$NAME" = primary ] && echo hub.crt || echo "hub-$NAME.crt")"
printf '%s\n' "$PEM" > "$CRT"
cat > "$OUT/hub.env" <<ENV
IOT_ENDPOINT=$ENDPOINT
HUB_ID=$HUB_ID
AWS_REGION=$REGION
ENV

echo "certificate '$NAME' ($STATUS) id=${CERT_ID:0:12}…"
echo "wrote $CRT"
echo "wrote $OUT/hub.env"
echo
echo "On the hub machine:"
echo "  cp $CRT <hearth-hub>/certs/hub.crt"
echo "  merge $OUT/hub.env into <hearth-hub>/config/hub.env (keep OLLAMA_MODEL and other local settings)"
