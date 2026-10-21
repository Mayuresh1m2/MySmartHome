# 32: hub M4 reboot test against real AWS

Owner: shut the laptop down, asked the Echo while it was off, booted it and asked again.

## Hub off → honest fallback

```text
Lambda 16:16:43  requestId 98bd162b-…  outcome "timeout"  latencyMs 5004   (Echo: "your hub is offline")
```

## Boot → hub up with no manual steps

```text
uptime -s                         2026-10-21 16:17:08
systemd --user manager (linger)   16:17:22
hearth-hub / hearth-ollama        Started 16:17:24
relay "connected and subscribed"  16:17:30   hearth/laptop/commands
owner's desktop login (gdm)       16:17:37   ← after the hub was already connected
model warmed up                   16:17:48   warmUpMs 19201
```

## First command after boot

```text
hub    16:17:58  requestId d1e66f6e-…  tool disk_space  decision allowed  outcome ok  intent 2252 ms  total 2271 ms
Lambda 16:17:58  requestId d1e66f6e-…  outcome "ok"  latencyMs 2945
```

Same `requestId` on both sides. hearth-hub M4 is done ("answers Alexa after a reboot with no manual steps").
