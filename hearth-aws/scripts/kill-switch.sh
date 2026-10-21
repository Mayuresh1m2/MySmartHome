#!/usr/bin/env bash
# Hearth kill switch (AWS Budgets action that denies the skill and rule roles at the cost limit).
#   scripts/kill-switch.sh show             limit in config/local.json + the deployed action's state
#   scripts/kill-switch.sh set <usd>        change the limit in config/local.json (then: pnpm test && pnpm cdk diff && pnpm cdk deploy)
#   scripts/kill-switch.sh reset            after it tripped: reverse the action (detaches the deny policy). Ask the owner first.
# Uses the AWS CLI's configured profile (AWS_PROFILE). Writes no credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${HEARTH_CONFIG:-$ROOT/config/local.json}"
REGION=eu-west-1

budget_name() { echo "hearth-$(jq -er .hubId "$CONFIG")-killswitch"; }
account() { aws sts get-caller-identity --query Account --output text; }

case "${1:-show}" in
  show)
    echo "config: killSwitchUsd=$(jq -r '.killSwitchUsd // 1' "$CONFIG") budgetAlertUsd=$(jq -r '.budgetAlertUsd // 5' "$CONFIG")"
    if command -v aws >/dev/null && aws sts get-caller-identity >/dev/null 2>&1; then
      aws budgets describe-budget-actions-for-budget --account-id "$(account)" --budget-name "$(budget_name)" --region "$REGION" \
        --query 'Actions[].{status:Status,threshold:ActionThreshold.ActionThresholdValue,type:ActionType}' --output table 2>/dev/null \
        || echo "deployed: (not found; deploy the stack first)"
    else echo "deployed: (AWS CLI not signed in)"; fi
    ;;
  set)
    usd="${2:?usage: kill-switch.sh set <usd>}"
    [[ "$usd" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v v="$usd" 'BEGIN{exit !(v > 0 && v <= 100)}' || { echo "limit must be a number in (0, 100]" >&2; exit 2; }
    tmp=$(mktemp); jq --argjson v "$usd" '.killSwitchUsd = $v' "$CONFIG" > "$tmp" && mv "$tmp" "$CONFIG"
    echo "killSwitchUsd=$usd in $CONFIG. Next: pnpm test && pnpm cdk diff && pnpm cdk deploy   (in-place budget update)"
    ;;
  reset)
    id=$(aws budgets describe-budget-actions-for-budget --account-id "$(account)" --budget-name "$(budget_name)" --region "$REGION" --query 'Actions[0].ActionId' --output text)
    aws budgets execute-budget-action --account-id "$(account)" --budget-name "$(budget_name)" --action-id "$id" --execution-type REVERSE_BUDGET_ACTION --region "$REGION"
    echo "reversed: the deny policy is detached; Hearth works again. It trips again if this month's cost is still over the limit."
    ;;
  *) sed -n '2,7p' "$0"; exit 2 ;;
esac
