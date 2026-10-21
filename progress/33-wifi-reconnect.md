# 33: hub M1 Wi-Fi reconnect test (real IoT Core)

Owner switched Wi-Fi off and on while the hub was running.

## NetworkManager

```text
16:27:43  rfkill: Wi-Fi now disabled · wlp3s0 activated -> unavailable
16:28:23  rfkill: Wi-Fi now enabled  · wlp3s0 unavailable -> disconnected -> (reconnects)
```

## Hub relay (times IST)

```text
16:28:21  mqtt error Keepalive timeout          ← the dead socket is noticed by keepalive (30 s), not by Wi-Fi going down
16:28:21  reconnect scheduled attempt=1 delay=830ms
16:28:22  mqtt error getaddrinfo EAI_AGAIN …-ats.iot.ap-southeast-2.amazonaws.com   (no network yet)
16:28:22  reconnect scheduled attempt=2 delay=1863ms
16:28:24  reconnect scheduled attempt=3 delay=2144ms
16:28:26  reconnect scheduled attempt=4 delay=5151ms
16:28:33  connected and subscribed hearth/laptop/commands     ← ~10 s after Wi-Fi came back, no manual step
health: {"mqtt":{"state":"connected","lastError":null,"reconnectAttempt":0}}
```

## End to end after the reconnect

```text
aws iot-data publish hearth/laptop/commands {"v":1,"requestId":"6b32fb2a-…","text":"ping",…}
reply item after ~1s: {"status":"ok","speech":"Hub is online."}
hub: command handled tool ping outcome ok latencyMs 1671
```

hearth-hub M1 is done. A command sent while the link is down but not yet noticed (up to ~30 s keepalive window here) gets the Lambda's honest "hub didn't answer" fallback; the hub's 10 s staleness rule drops it if it arrives late.
