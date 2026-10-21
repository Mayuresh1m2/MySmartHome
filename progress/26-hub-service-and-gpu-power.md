# 26 — Hub as a systemd user service; GPU power and access fixes (PLAN H2 = hub M4)

Date: 2026-10-21. Your decisions: systemd user units + linger, targeting the local stack until AWS exists; keep the GPU awake.

## Units (`deploy/systemd/*.service.in`, installed by `scripts/services.sh install [--target local|aws]`)

| Unit | What | Notes |
|---|---|---|
| `hearth-ollama` | `ollama serve` on 127.0.0.1:11434 | `ExecStartPre=scripts/wait-gpu.sh 120` (see below) |
| `hearth-local-iot` | Mosquitto IoT emulator (MQTT 5, mTLS) | oneshot; waits for the Docker socket (a user unit can't order after the system docker.service); the container also has `restart: unless-stopped` |
| `hearth-local-stack` | the emulated cloud | `ExecStartPre=local-stack/scripts/prepare.sh` (CA, hub cert from the CSR, hub.local.env); `prepare.sh` was split out of `up.sh` |
| `hearth-hub` | the hub on qwen2.5:3b | `HUB_ENV_FILE` = local-stack env now; `--target aws` switches to `config/hub.env`; `Restart=on-failure`, `NoNewPrivileges` |

- **Linger** (`loginctl enable-linger`) worked without sudo, so the units start at boot with no login.
- **Logs:** go to journald, which rotates them. `hearth:trace` now merges `journalctl --user -u 'hearth-*'` with the stack log files. Hub audit JSONL: `AUDIT_RETENTION_DAYS` (default 90), pruned at startup and daily (tested).

Evidence:

```text
$ scripts/services.sh install
Created symlink …/default.target.wants/hearth-{ollama,local-iot,local-stack,hub}.service
linger enabled (services start at boot without a login)
  hearth-ollama active enabled · hearth-local-iot active enabled · hearth-local-stack active enabled · hearth-hub active enabled
$ kill -9 <hub MainPID 19994>
hearth-hub.service: Main process exited, code=killed, status=9/KILL
hearth-hub.service: Scheduled restart job, restart counter is at 1.        new MainPID 20700; answers "Hub is online." 1545 ms
```

## Finding 1: the dGPU runtime-suspends after 5 s idle, and every voice command after idle missed the model

```text
/sys/class/drm/card0/device/power: runtime_status=suspended control=auto autosuspend_delay_ms=5000   (model loaded in VRAM)
GPU suspended → request {"wallMs":4671,"promptMs":3139,"genMs":1459}        ×2: 4671 / 4596 ms
GPU active    → request {"wallMs":1572,"promptMs":98,"genMs":1459}          ×2: 1572 / 1583 ms
```

After a resume, the prompt (~520 tokens) is reprocessed: 3.1 s instead of 0.1 s. The total, 4.6 s, exceeds the 4.3 s model budget, and real commands are rare, so **almost every command fell back to the keyword router**. Fix (you ran it): `scripts/install-prereqs.sh --gpu-awake` writes `/etc/udev/rules.d/90-hearth-dgpu-awake.rules`:

```text
ACTION=="add|bind", SUBSYSTEM=="pci", ATTR{vendor}=="0x1002", ATTR{device}=="0x6820", ATTR{power/control}="on"
```

It's scoped to this one GPU and applied immediately: `control=on status=active`, and it idles at ~51–61 °C. Commands afterwards: 1.6–1.7 s on the model. It survived the reboot (`control=on` after boot).

## Reboot test (hub M4 acceptance, local stack)

```text
boot 11:54:28 → hearth-hub active 11:54:51, NRestarts=0, "connected and subscribed" immediately; model warmed up (64 s cold load)
> how much space is left    🗣 You have 142 gigabytes free out of 467, about 30 percent.   ok       3597 ms
> can you reach the router  🗣 The router is online.                                      ok       4172 ms
> unlock the front door     🗣 Sorry, I can't do that.                                    refused  3548 ms
(all three "model decided"; no fallback)
```

So the hub answers after a reboot with no manual steps. **But it was slow**, and that led to:

## Finding 2: at boot, Ollama ran on the CPU, because GPU access depended on a desktop login

```text
$ ollama ps → qwen2.5:3b 100% CPU
hearth-ollama (11:54:46): msg="inference compute" id=cpu library=cpu       ← no GPU found
/dev/dri/renderD129: crw-rw----+ root render … 11:55      ACL: user:$USER:rw- (added by logind at the tty2 login, ~11:55)
groups: … docker   (not render, not video)
```

The render nodes are `root:render 660`. This account had access only through the ACL that logind adds **at a seat login**, and the device nodes appeared at 11:55, after Ollama had started at 11:54:46. Ollama picks its device once at startup, so it stayed on the CPU: generation 2.3–3.1 s, prompt 0.85–1.0 s. Restarting it after the login put it back on the GPU (1.7–2.0 s).

Fixes:

- `scripts/wait-gpu.sh` + `ExecStartPre` in `hearth-ollama`: wait up to 120 s for an **accessible AMD render node** (vendor 0x1002), then start (exit 0 anyway, so it falls back to CPU rather than failing).
- `install-prereqs.sh --system` now adds **`render` and `video`** groups, and `--check` reports them. **Needs your sudo + a reboot** (the lingering user manager picks up groups only when it starts).

## Bug fixed along the way

Reinstalling the units ran `local-stack/scripts/down.sh` to stop hand-started processes, which also stopped the **unit-owned** IoT container (hub → `reconnecting`). `services.sh install` now only runs `down.sh` when hand-started PID files exist, and restarts the units so changed definitions take effect.

## Remaining for M4

1. You: `sudo usermod -aG render,video $USER` (or rerun `scripts/install-prereqs.sh --system`), then reboot.
2. Me: confirm `ollama ps` shows 100% GPU right after boot, with the first commands at ~1.6–2 s.
3. Real "Alexa" after a reboot waits for AWS (G3/G4), then `scripts/services.sh install --target aws`.
