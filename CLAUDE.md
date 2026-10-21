# Hearth monorepo

Three projects, each with its own CLAUDE.md that governs work inside it:

- `hearth-aws/`: cloud half (CDK, Alexa skill Lambda)
- `hearth-hub/`: home hub service
- `hearth-devices/`: local device platform

Shared:

- `contracts/`: JSON Schemas and fixtures for the cloud↔hub contract (v1) and the local device contract (v1). Change a contract here first, then both sides in the same commit.
- `local-stack/`: runs the whole system on one machine without AWS (emulated IoT Core broker with mTLS, emulated DynamoDB).
- `PLAN.md`: master plan and approval gates. `progress/`: journal of every step, with evidence.

Setup:

- Prerequisites live in `scripts/install-prereqs.sh`. `--check` (the default) reports; `--user` installs everything that needs no root; `--system` and `--devices-tools` need sudo; `--aws` and `--ask` are opt-in (gates G3/G4).
- Claude never runs `sudo`: it can't answer the password prompt, and sudo steps are the owner's to approve. Ask the owner to run `scripts/install-prereqs.sh --system` in a separate terminal, then verify with `--check`.
- Docker group membership only applies after a fresh login. If `--check` says "not active yet", the owner logs out and back in, then resumes Claude with `claude -c`.
- Ollama runs as a user process (`scripts/ollama.sh start|stop|status`), not a system service.

Rules:

- When working in a project, follow that project's CLAUDE.md. The root `.claude/settings.json` merges every project's guardrails.
- Every step gets a `progress/NN-<slug>.md` entry with commands and real output.
- Never read `hearth-hub/certs/hub.key`. Never commit secrets, `config/local.json`, `out/`, `certs/` or `secrets/`.
