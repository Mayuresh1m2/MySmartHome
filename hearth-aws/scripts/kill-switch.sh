#!/usr/bin/env bash
# Hearth kill switches: AWS Budgets actions (automatic, no code of ours) that attach a deny-all policy to the
# skill and rule roles when actual monthly cost reaches a limit. Two of them:
#   hearth   Hearth's own costs (tag project=hearth)   config: hearthKillSwitchUsd  (default 1)
#   account  the whole account's costs                  config: accountKillSwitchUsd (default 5)
# Both stop Hearth only; neither deletes anything.
#
#   scripts/kill-switch.sh show                    limits in config/local.json + the deployed actions' state
#   scripts/kill-switch.sh set hearth|account <usd>  change a limit in config/local.json
#                                                  (then: pnpm test && pnpm cdk diff && pnpm cdk deploy)
#   scripts/kill-switch.sh reset hearth|account    after a trip: reverse that action (detach the deny policy). Ask the owner first.
# Uses the AWS CLI's configured profile (AWS_PROFILE). Writes no credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${HEARTH_CONFIG:-$ROOT/config/local.json}"
REGION=eu-west-1

hub() { jq -er .hubId "$CONFIG"; }
budget_of() { case "$1" in hearth) echo "hearth-$(hub)-killswitch" ;; account) echo "hearth-$(hub)-monthly" ;; *) echo "which switch: hearth|account" >&2; exit 2 ;; esac; }
key_of() { case "$1" in hearth) echo hearthKillSwitchUsd ;; account) echo accountKillSwitchUsd ;; *) echo "which switch: hearth|account" >&2; exit 2 ;; esac; }
max_of() { [ "$1" = hearth ] && echo 100 || echo 1000; }
account_id() { aws sts get-caller-identity --query Account --output text; }

case "${1:-show}" in
  show)
    echo "config: hearthKillSwitchUsd=$(jq -r '.hearthKillSwitchUsd // 1' "$CONFIG")  accountKillSwitchUsd=$(jq -r '.accountKillSwitchUsd // 5' "$CONFIG")"
    if command -v aws >/dev/null && aws sts get-caller-identity >/dev/null 2>&1; then
      for w in hearth account; do
        printf '%-8s ' "$w"
        aws budgets describe-budget-actions-for-budget --account-id "$(account_id)" --budget-name "$(budget_of "$w")" --region "$REGION" \
          --query 'Actions[0].Status' --output text 2>/dev/null || echo "(not deployed)"
      done
    else echo "deployed state: AWS CLI not signed in"; fi
    ;;
  set)
    which="${2:?usage: kill-switch.sh set hearth|account <usd>}"; usd="${3:?usage: kill-switch.sh set hearth|account <usd>}"
    key=$(key_of "$which"); max=$(max_of "$which")
    [[ "$usd" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v v="$usd" -v m="$max" 'BEGIN{exit !(v > 0 && v <= m)}' || { echo "limit must be a number in (0, $max]" >&2; exit 2; }
    tmp=$(mktemp); jq --arg k "$key" --argjson v "$usd" '.[$k] = $v' "$CONFIG" > "$tmp" && mv "$tmp" "$CONFIG"
    echo "$key=$usd in $CONFIG. Next: pnpm test && pnpm cdk diff && pnpm cdk deploy   (in-place budget update)"
    ;;
  reset)
    which="${2:?usage: kill-switch.sh reset hearth|account}"; name=$(budget_of "$which")
    id=$(aws budgets describe-budget-actions-for-budget --account-id "$(account_id)" --budget-name "$name" --region "$REGION" --query 'Actions[0].ActionId' --output text)
    aws budgets execute-budget-action --account-id "$(account_id)" --budget-name "$name" --action-id "$id" --execution-type REVERSE_BUDGET_ACTION --region "$REGION"
    echo "reversed $which: the deny policy is detached (unless the other switch also tripped). It trips again if this month's cost is still over the limit."
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
