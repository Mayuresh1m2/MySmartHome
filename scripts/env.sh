# Sourced by Hearth scripts: loads the repo-root .env (or $HEARTH_ENV_FILE) into the environment.
# Only KEY=value lines are read (nothing is executed); variables already set in the environment win.
hearth_repo_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }
hearth_env_file() { echo "${HEARTH_ENV_FILE:-$(hearth_repo_root)/.env}"; }
hearth_load_env() {
  local f; f="$(hearth_env_file)"
  [ -f "$f" ] || { echo "missing $f: cp .env.example .env, then scripts/configure.sh" >&2; return 1; }
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    v="${v%\"}"; v="${v#\"}"
    [ -n "${!k:-}" ] || export "$k=$v"
  done < "$f"
}
# Sets KEY=value in the env file (replacing the line, or appending it).
hearth_set_env() {
  local f key="$1" val="$2"; f="$(hearth_env_file)"
  if grep -q "^$key=" "$f"; then
    local tmp; tmp=$(mktemp); awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$f" > "$tmp" && cat "$tmp" > "$f" && rm -f "$tmp"
  else
    echo "$key=$val" >> "$f"
  fi
}
