# Hearth monorepo

Three projects, each with its own CLAUDE.md that governs work inside it:

- `hearth-aws/`: cloud half (CDK, Alexa skill Lambda)
- `hearth-hub/`: home hub service
- `hearth-devices/`: local device platform

Shared:

- `contracts/`: JSON Schemas and fixtures for the cloud↔hub contract (v1) and the local device contract (v1). Change a contract here first, then both sides in the same commit.
- `local-stack/`: runs the whole system on one machine without AWS (emulated IoT Core broker with mTLS, emulated DynamoDB).
- `PLAN.md`: master plan and approval gates. `progress/`: journal of every step, with evidence.

Rules:

- When working in a project, follow that project's CLAUDE.md. The root `.claude/settings.json` merges every project's guardrails.
- Every step gets a `progress/NN-<slug>.md` entry with commands and real output.
- Never read `hearth-hub/certs/hub.key`. Never commit secrets, `config/local.json`, `out/`, `certs/` or `secrets/`.
