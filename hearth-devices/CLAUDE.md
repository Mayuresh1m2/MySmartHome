# Hearth devices

A local platform that lets the Hearth hub see and control the devices in my home: one adapter per kind of device, all behind one common contract. It starts as research. For each device, find the most local way to control it and write that down before writing any control code.

Related projects: hearth-hub consumes this platform through its `DeviceGateway`. hearth-aws isn't involved.

## My devices

Fill this in during Phase 0. Don't assume a model: ask me, or read it from the device or its app.

| Device | Model | Firmware | IP / MAC | App it's set up with | Class |
|---|---|---|---|---|---|
| Smart TV | | | | | |
| Robot vacuum | | | | | |
| Dishwasher | | | | | |
| Refrigerator | | | | | |
| Echo devices (several) | | | | | |
| Echo Show devices | | | | | |
| Smart doorbell | | | | | |
| Car with a connected-car app | | | | | |

Starting leads for each device are in `docs/device-leads.md`. Treat them as unverified starting points, not facts.

## Classify every device

Prefer the lowest class available:

1. Local standard: Matter, or a documented LAN API
2. Local but unofficial: a reverse-engineered LAN protocol, often needing a key or token pulled once from the vendor account
3. Cloud only: an official or unofficial API through the vendor's servers
4. Observe only: no control, just presence, online status and network behavior

Record the class, the evidence and the risks in `docs/devices/<device>.md`.

## Architecture

- Bus: a local MQTT broker (Mosquitto) on the hub machine, password-protected, bound to localhost unless an adapter has to run elsewhere. Every adapter and the hub speak the contract below.
- Adapters: one process per adapter, as a container or service, in any language. Default to Python with uv, since most device libraries are Python, and use TypeScript when the best library is Node.
- Adapter SDK: small Python and TypeScript base libraries that handle the MQTT plumbing, meta, state and result publishing, the last-will offline status and schema validation. An adapter then only implements discovery, state and commands.
- Core: a registry built from adapter meta, a discovery coordinator (mDNS, SSDP and ARP scans), device-level policy by risk class, and an audit log.
- Matter devices: commission them to a Matter controller on the hub (python-matter-server or the matter.js controller) using multi-admin, alongside Alexa. That controller is wrapped as one adapter.
- Capability names follow Matter clusters where one fits (OnOff, LevelControl, MediaPlayback, RvcRunMode, RvcCleanMode, RvcOperationalState, ServiceArea, OperationalState, DoorLock), so the hub's Matter bridge can map them later.

## Local contract v0

- `hearth/local/devices/<deviceId>/meta` (retained): `{"v":0,"id","name","room","kind","adapter","capabilities":[{"name","params":<JSON Schema>,"risk":"read|low|medium|high"}]}`
- `hearth/local/devices/<deviceId>/state` (retained): `{"v":0,"online":true,"updatedAt":<epoch ms>, ...capability values}`
- `hearth/local/devices/<deviceId>/set`: `{"v":0,"requestId","capability","action","params"}`
- `hearth/local/devices/<deviceId>/result`: `{"v":0,"requestId","ok":true,"error":null,"state":{...}}`
- `hearth/local/adapters/<adapterId>/status` (retained, set by last will): `online` or `offline`

To change the contract, bump `v` and update hearth-hub's `DeviceGateway` in the same change.

## Risk classes

- read: state only
- low: lights, TV volume and input, plugs for lamps
- medium: starting or stopping the vacuum or a dishwasher program, TV power
- high: locks, doors, any lock relay on the doorbell, the car's remote commands (lock, unlock, engine, climate, windows, sunroof), and anything that heats

High is disabled by default and is never reachable by voice. Medium requires the device to be online and idle.

## Exploration rules

- Only scan, probe or capture traffic on my own network and my own devices.
- Go in this order: passive inventory (router DHCP list, mDNS and SSDP browsing), then a service scan of one device at a time, then read-only API calls, then control.
- IMPORTANT: never flash firmware, root, factory reset or change a device's network settings without my explicit go-ahead for that specific device.
- Never send a command that could cause damage or harm, such as heating, unlocking, opening, or anything on the car.
- Tokens, keys and passwords go in `secrets/` (gitignored), never in code, docs, logs or commits.
- Flag any approach that relies on undocumented APIs or keys extracted from a vendor account. I decide whether to use it.
- For each device, record which internet endpoints it contacts and whether it still works with internet access blocked. I need this for firewall rules.
- Write findings before writing code.

## Stack

- Mosquitto; Python 3.12+ with uv, pytest, ruff, pydantic and aiomqtt; TypeScript with vitest for Node adapters
- Docker Compose with host networking, because multicast discovery needs it
- Exploration tools: nmap, avahi-browse or dns-sd, tcpdump or Wireshark on my own traffic, mosquitto_sub and mosquitto_pub

## Phases

### Phase 0: Inventory and research
- Fill in the device table, write one doc per device, classify each, and recommend an order.
- Done when every device has a doc with its class, evidence, chosen approach, risks and internet dependence.

### Phase 1: Platform skeleton
- Mosquitto with authentication, the adapter SDKs, contract schemas with validation tests, a fake adapter, the registry and the audit log.
- Done when the fake adapter shows up in the registry, handles a `set`, publishes `result` and `state`, and goes offline cleanly through its last will.

### Phase 2: First real adapter
- Start with the most local device, probably the TV: power on through Wake-on-LAN, power off, volume, mute, input or app launch, and state polling.
- Done when the commands work from `mosquitto_pub`, with tests against recorded fixtures.

### Phase 3: The remaining devices
- One at a time, in Phase 0's order. Each adapter ships with its doc, fixtures, tests and default policy entries.

### Phase 4: Hub integration
- hearth-hub's `DeviceGateway` talks to this platform, and its device tools come from capabilities here.

### Phase 5: Observe-only devices
- Presence and online status, plus a summary of each device's outbound traffic.

## Working rules

- One device per branch and per session. Run `/clear` between devices.
- Use subagents for broad research across forums, GitHub issues and Home Assistant integrations, and keep the main session for decisions and code.
- Home Assistant integrations are good protocol references. Check licenses before copying code, and attribute anything you port.
- When unsure whether an action is safe for a device, ask me first.
