# Device leads

Unverified starting points by device type, gathered in October 2026. Check each one against the actual model, firmware and app before relying on it. Brand-specific leads for the owner's own devices are in `docs/private/device-leads.md` (gitignored).

## Smart TV

- Many smart TVs expose a local remote-control API on the LAN (often a WebSocket or REST endpoint), usually with a one-time pairing prompt on the TV. Powering on usually needs Wake-on-LAN, because the network stack sleeps when the TV is off.
- References: the Home Assistant integration for the TV's platform, and the Python library it uses.
- Cloud fallback: the vendor's smart-home API, if it has one.
- Some TVs also act as a smart-home hub or Matter controller. That's a controller role. It doesn't make the TV itself controllable over Matter.
- Likely class 1 or 2.

## Robot vacuum

- Check first whether the model is on the CSA's certified Matter product list. Recent models from several brands are certified as Matter robotic vacuums (run mode, clean mode, operational state, rooms). If yours is one, commission it to the hub with multi-admin. Class 1.
- If not, it depends on the app it's paired with: some app ecosystems have a local LAN protocol with a per-device token (see the matching Home Assistant integration); others are cloud only.
- Fully local alternative: open firmware projects support rooting some models. This can void the warranty and brick the device, so only with my go-ahead.

## Dishwasher

- Connected dishwashers usually have an official cloud API with OAuth.
- Some have community projects that talk to the appliance over the LAN after fetching per-device keys from the account once. These are beta quality and rely on extracted keys, so flag them to me. Class 2.
- Matter: check the model and the vendor app for a Matter pairing code, and whether the vendor sells a Matter bridge for its appliances in India.

## Refrigerator

- Cloud: the vendor's official smart-home API with a personal access token. Class 3 unless something better turns up.
- Check whether the model exposes itself as a Matter device. Some fridges are Matter controllers; don't assume the fridge itself is a Matter device.

## Echo and Echo Show devices

- Not controllable as devices in a supported way. They're Alexa's microphones, speakers and screens, and they act as Matter controllers. Some are also Thread border routers or Zigbee hubs.
- To make one speak, the supported route is a virtual contact sensor on the hub's Matter bridge that triggers an Alexa routine with an announcement.
- Unofficial: Alexa Media Player and `alexapy` use Amazon's private web API. It's cloud, breaks often and may violate Amazon's terms, so flag it before using.
- Class 4 for control, but useful as output devices through routines.

## Smart doorbell

- Depends entirely on the brand. Some have local options, such as RTSP or ONVIF video and local events on Reolink, or `eufy-security-ws` for some Eufy models. Ring and Nest are cloud only.
- Goal: ring and motion events plus a snapshot. Never connect it to any lock action.

## Car

- Connected cars usually do remote features (lock and unlock, remote start and climate, windows, location) through the maker's cloud and app, often with no public API.
- Car to home may already work another way. If the car has Alexa built in, "ask ramesh dude" may work from the car on the same Amazon account. Check this first.
- Home-side options: presence (the car or my phone appearing on home Wi-Fi or Bluetooth), an OBD-II dongle for read-only diagnostics while parked, or reverse-engineering the app's API. The last one carries terms-of-service and safety risk, so read-only at most, and never remote start or unlock.
- Class 3 at best for remote features, class 4 by default.
