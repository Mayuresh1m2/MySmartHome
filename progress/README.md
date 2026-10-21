# Progress journal

The whole setup journey, in order. Each file covers one step from `PLAN.md`: its goal, the plan, commands that were run, real output as evidence, decisions, and problems hit along the way.

| # | File | Plan item | Status |
|---|---|---|---|
| 00 | [00-kickoff-and-environment.md](00-kickoff-and-environment.md) | Planning, environment survey | done |
| 01 | [01-monorepo-and-toolchain.md](01-monorepo-and-toolchain.md) | A1, A2 | done |
| 02 | [02-contracts-and-doctor.md](02-contracts-and-doctor.md) | A3, A4 | done |
| 03 | [03-hub-scaffold.md](03-hub-scaffold.md) | B1 | done |
| 04 | [04-hub-identity-and-local-ca.md](04-hub-identity-and-local-ca.md) | B2 | done |
| 05 | [05-hub-relay.md](05-hub-relay.md) | B3 | done |
| 06 | [06-hub-health-and-smoke.md](06-hub-health-and-smoke.md) | B4 | done |
| 07 | [07-hub-tools-policy-audit.md](07-hub-tools-policy-audit.md) | B5 | done |
| 08 | [08-aws-skill-and-cdk.md](08-aws-skill-and-cdk.md) | C1, C2 | done |
| 09 | [09-local-stack-e2e.md](09-local-stack-e2e.md) | C3, C4 | done |
| 10 | [10-devices-sdks.md](10-devices-sdks.md) | E1 | done |
| 11 | [11-devices-core-fake-adapter.md](11-devices-core-fake-adapter.md) | E2 | done |
| 12 | [12-hub-device-gateway.md](12-hub-device-gateway.md) | F1 | done |
| 13 | [13-aws-hardening.md](13-aws-hardening.md) | H1 (+ handoff.sh) | done; runbook awaits review |
| 14 | [14-skill-package.md](14-skill-package.md) | aws M3 (offline part) | done; privacy answers await review |
| 15 | [15-hub-ollama-intent.md](15-hub-ollama-intent.md) | D2 | code done; real model waits for G2 |
| 16 | [16-hub-eval-harness.md](16-hub-eval-harness.md) | D3 | harness done; model run waits for G2 |
| 17 | [17-readmes.md](17-readmes.md) | H3 | done; ASK commands confirmed at M3 |
| 18 | [18-ollama-qwen-eval.md](18-ollama-qwen-eval.md) | D1 (G2) | qwen2.5:3b evaluated; latency target missed, decision pending |
| 19 | [19-local-contract-v1-hub-via-core.md](19-local-contract-v1-hub-via-core.md) | F2 | done |
| 20 | [20-gpu-finding-and-model-comparison.md](20-gpu-finding-and-model-comparison.md) | D1 | GPU discovered; 3b-on-GPU best; reboot + soak test next |
| 21 | [21-gpu-soak-thermal-shutdown.md](21-gpu-soak-thermal-shutdown.md) | D1 | GPU stable for 249 requests; laptop thermal shutdown; decision pending |
| 22 | [22-thermal-guard.md](22-thermal-guard.md) | D1 decided (hub M3) | done |
| 23 | [23-docker-and-prereqs.md](23-docker-and-prereqs.md) | G1 + prereqs script | engine installed; re-login pending |
| 24 | [24-mosquitto-bus.md](24-mosquitto-bus.md) | E3 (devices Phase 1) | done |
| 25 | [25-iot-emulator-mqtt5.md](25-iot-emulator-mqtt5.md) | E3 follow-up (hub on MQTT 5) | done |
| 26 | [26-hub-service-and-gpu-power.md](26-hub-service-and-gpu-power.md) | H2 (hub M4) | done on the local stack; real-Alexa reboot after AWS |
| 27 | [27-cost-kill-switch.md](27-cost-kill-switch.md) | hearth-aws cost guard | done |
| 28 | [28-aws-account-and-region.md](28-aws-account-and-region.md) | G1′ (AWS account) | done; region ap-southeast-2 |
| 29 | [29-env-config-and-privacy.md](29-env-config-and-privacy.md) | privacy + .env | done |
| 30 | [30-first-deploy.md](30-first-deploy.md) | aws M2, hub M1 | deployed; hub on real IoT Core |
| 31 | [31-skill-live.md](31-skill-live.md) | aws M3, hub M2 | done; works on the Echo as "ramesh dude" |
| 32 | [32-reboot-test-aws.md](32-reboot-test-aws.md) | hub M4 | done |
| 33 | [33-wifi-reconnect.md](33-wifi-reconnect.md) | hub M1 | done |
| 34 | [34-killswitch-whole-account.md](34-killswitch-whole-account.md) | cost guard | done |
| 35 | [35-stop-start.md](35-stop-start.md) | laptop footprint, off switch | done; suspend/resume untested |
| 36 | [36-publish-prep.md](36-publish-prep.md) | publishing | done |
