# 01 — Monorepo layout and toolchain (PLAN A1, A2)

Date: 2026-10-21 · Branch: `hearth-setup` (master had no commits; `main` is the PR base)

## Goal

Turn four loose spec files into a monorepo that has guardrails, and get a package manager working without sudo.

## What was done

### A1: Layout

```bash
git checkout -b hearth-setup
mv aws-project-CLAUDE.md            hearth-aws/CLAUDE.md
mv hub-project-CLAUDE.md            hearth-hub/CLAUDE.md
mv devices-project-CLAUDE.md        hearth-devices/CLAUDE.md
mv devices-project-device-leads.md  hearth-devices/docs/device-leads.md   # the path its CLAUDE.md references
```

Added:

- `.gitignore`: covers everything each spec says must never be committed: `hearth-aws/config/local.json`, `out/`, `.ask/`, `cdk.out/`, `hearth-hub/certs/`, `config/hub.env`, `data/`, `hearth-devices/secrets/`, plus `local-stack/.state/` (local CA and broker keys).
- `pnpm-workspace.yaml`: packages for aws, the skill lambda, hub, contracts, local-stack and the TS device SDK.
- Guardrails:
  - `hearth-aws/.claude/settings.json` and `hearth-hub/.claude/settings.json`, verbatim from each spec (they apply when Claude is started inside that project).
  - Root `.claude/settings.json` merges both (sessions are usually started at the root). Path-based rules were rewritten for the root: `Read(./hearth-hub/certs/hub.key)` and `Read(**/certs/hub.key)`. Variants for `pnpm --filter * cdk deploy|destroy` were added, since that's how a monorepo invokes CDK.
- Root `CLAUDE.md`: a short map of the repo plus the cross-project rules.

### A2: Toolchain

The node on PATH is `~/.local/bin/node → ~/.hermes/node/bin/node` (v22.23.1). fnm's default is v20.20.1, but it comes later on PATH.

```text
$ corepack enable --install-directory ~/.local/bin pnpm
$ pnpm --version
Downloading the pnpm 12.14.0 binary for linux-x64...
12.14.0
$ pnpm install
Already up to date
Done in 50ms using pnpm v12.14.0
```

Root `package.json` pins `"packageManager": "pnpm@12.14.0"` and `engines.node >= 22`. `.nvmrc` is `22`.

## Notes and issues

- **Heads-up:** the `~/.local/bin/pnpm` shim symlinks into fnm's **v20** corepack install. It works, but removing node v20 from fnm would break it. Re-run the `corepack enable` line if that happens.
- Docker still needs `sudo usermod -aG docker $USER` (gate G1). Nothing in this phase depends on it.
- The staged IntelliJ files (`.idea/*`, `MySmartHome.iml`) were kept as the user staged them. `.idea/.gitignore` already excludes `workspace.xml`.
