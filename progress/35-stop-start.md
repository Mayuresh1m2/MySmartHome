# 35: what Hearth costs the laptop, and an off switch

## Footprint while running (idle, 20 min after boot, on AC)

```text
hearth-ollama  MemoryCurrent 2.16 GB (incl. model file cache)  CPU 7.0 s in 20 min (mostly the 19 s warm-up)
               qwen2.5:3b resident in VRAM: 2.09 GB of the R9 M375's 4 GB, keep_alive forever
hearth-hub     MemoryCurrent 168 MB  CPU 5.8 s in 20 min (≈0.5 % of one core)
devices bus    mosquitto container 4.7 MB RSS (restart: unless-stopped; nothing uses it yet: hub DEVICES=json)
temps          amdgpu 53 °C, coretemp 56–58 °C, load average 0.6–0.7
dGPU           card0 (0x1002) power/control=on runtime_status=active ← /etc/udev/rules.d/90-hearth-dgpu-awake.rules
network        one MQTT connection, keepalive every 30 s
```

## `scripts/services.sh stop|start`

`stop`: `systemctl --user disable --now` every installed hearth unit, stops a hand-started Ollama or local stack,
`bus.sh down` for the devices bus. `start`: `enable --now` the installed units and wait for health.

```text
$ scripts/services.sh stop            (used RAM 4029 → 3612 MiB)
  hearth-ollama        inactive  disabled
  hearth-hub           inactive  disabled
  devices bus: stopped · model in memory: none (Ollama stopped)
no Hearth listeners on :11434 :8787 :1883 · 0 ollama/llama-server/tsx processes
dGPU after 20 s: 55 °C, runtime_status=active   ← the udev rule keeps it powered even with Hearth off

$ scripts/services.sh start           (1.7 s)
  hearth-ollama active enabled · hearth-hub active enabled
+25 s health: {"status":"ok","mqtt":"connected","modelLoaded":true}
```

## Sleep (from settings, not tested)

```text
gsettings sleep-inactive-ac-type 'suspend', timeout 0      → never idle-suspends on AC
gsettings sleep-inactive-battery-type 'suspend', timeout 900 → suspends after 15 min idle on battery
logind: no HandleLidSwitch override                         → closing the lid suspends
/sys/power/mem_sleep: s2idle [deep]                         → deep suspend: every process frozen
```

While suspended Alexa gets the Lambda fallback. After resume the relay should see the dead socket via keepalive and
reconnect (same path as progress/33). Not yet tested: suspend/resume, including whether the dGPU and the loaded model
survive resume (this GPU reported a lost device once, progress/21).
