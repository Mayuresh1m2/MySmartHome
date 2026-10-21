#!/usr/bin/env bash
# Hearth kill switches: AWS Budgets actions (automatic, no code of ours) that attach a deny-all policy to the
# skill and rule roles when actual monthly cost reaches a limit. Two of them:
#   hearth   the whole account's costs (no tag filter)   .env: HEARTH_KILL_SWITCH_USD          (default 1)
#   account  the whole account's costs                    .env: HEARTH_ACCOUNT_KILL_SWITCH_USD  (default 5)
# Both stop Hearth only; neither deletes anything.
#
#   scripts/kill-switch.sh show                    limits in .env, each budget's spend this month and its action's state
#   scripts/kill-switch.sh set hearth|account <usd>  change a limit in the repo-root .env
#                                                  (then: pnpm test && pnpm cdk diff && pnpm cdk deploy)
#   scripts/kill-switch.sh reset hearth|account    after a trip: reverse that action (detach the deny policy). Ask the owner first.
# Uses the AWS CLI's configured profile (AWS_PROFILE). Writes no credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/../scripts/env.sh"
hearth_load_env
REGION="${HEARTH_AWS_REGION:?set HEARTH_AWS_REGION in .env}"

hub() { echo "${HEARTH_HUB_ID:-laptop}"; }
budget_of() { case "$1" in hearth) echo "hearth-$(hub)-killswitch" ;; account) echo "hearth-$(hub)-monthly" ;; *) echo "which switch: hearth|account" >&2; exit 2 ;; esac; }
key_of() { case "$1" in hearth) echo HEARTH_KILL_SWITCH_USD ;; account) echo HEARTH_ACCOUNT_KILL_SWITCH_USD ;; *) echo "which switch: hearth|account" >&2; exit 2 ;; esac; }
max_of() { [ "$1" = hearth ] && echo 100 || echo 1000; }
account_id() { aws sts get-caller-identity --query Account --output text; }

case "${1:-show}" in
  show)
    echo ".env: HEARTH_KILL_SWITCH_USD=${HEARTH_KILL_SWITCH_USD:-1}  HEARTH_ACCOUNT_KILL_SWITCH_USD=${HEARTH_ACCOUNT_KILL_SWITCH_USD:-5}"
    if command -v aws >/dev/null && aws sts get-caller-identity >/dev/null 2>&1; then
      acct=$(account_id)
      budgets=$(aws budgets describe-budgets --account-id "$acct" --region "$REGION" --output json)
      actions=$(aws budgets describe-budget-actions-for-account --account-id "$acct" --region "$REGION" --output json)
      echo
      # One row per Hearth budget: what it counts, its limit, this month's actual spend, and its action's state.
      jq -rn --argjson b "$budgets" --argjson a "$actions" --arg hub "$(hub)" '
        def pad(n): tostring | if length < n then . + (" " * (n - length)) else .[0:n] end;
        def usd: tonumber | (. * 100 | round) as $c | "$\($c / 100 | floor).\(($c % 100 | tostring) as $s | if ($s | length) == 1 then "0" + $s else $s end)";
        "budget                     counts           limit   spent this month   at the limit",
        ($b.Budgets[] | select(.BudgetName | startswith("hearth-" + $hub + "-")) | . as $x
          | ([$a.Actions[] | select(.BudgetName == $x.BudgetName)][0]) as $act
          | "\($x.BudgetName | pad(25))  \((if ($x.CostFilters // {}) == {} then "whole account" else "filtered" end) | pad(15))  \($x.BudgetLimit.Amount | usd | pad(6))  \($x.CalculatedSpend.ActualSpend.Amount | usd | pad(17))  \(if $act then "deny-all on \($act.Definition.IamActionDefinition.Roles | length) Hearth roles (\($act.ApprovalModel | ascii_downcase), \($act.Status | ascii_downcase))" else "no action deployed" end)"),
        "",
        "Nothing is deleted when a switch trips: the skill and rule roles lose all permissions until it is reset."'
    else echo "deployed state: AWS CLI not signed in"; fi
    ;;
  set)
    which="${2:?usage: kill-switch.sh set hearth|account <usd>}"; usd="${3:?usage: kill-switch.sh set hearth|account <usd>}"
    key=$(key_of "$which"); max=$(max_of "$which")
    [[ "$usd" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v v="$usd" -v m="$max" 'BEGIN{exit !(v > 0 && v <= m)}' || { echo "limit must be a number in (0, $max]" >&2; exit 2; }
    hearth_set_env "$key" "$usd"
    echo "$key=$usd in $(hearth_env_file). Next: pnpm test && pnpm cdk diff && pnpm cdk deploy   (in-place budget update)"
    ;;
  reset)
    which="${2:?usage: kill-switch.sh reset hearth|account}"; name=$(budget_of "$which")
    id=$(aws budgets describe-budget-actions-for-budget --account-id "$(account_id)" --budget-name "$name" --region "$REGION" --query 'Actions[0].ActionId' --output text)
    aws budgets execute-budget-action --account-id "$(account_id)" --budget-name "$name" --action-id "$id" --execution-type REVERSE_BUDGET_ACTION --region "$REGION"
    echo "reversed $which: the deny policy is detached (unless the other switch also tripped). It trips again if this month's cost is still over the limit."
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
