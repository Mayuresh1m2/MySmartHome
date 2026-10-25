#!/usr/bin/env python3
"""Read-only Dreamehome probe for the Dreame L10 Prime.

Password policy (owner's choice): the account password is used ONCE, taken only from the
environment, and is NEVER written to disk. After a successful login we persist only the
**revocable auth token** (change the account password and it dies) plus non-secret
metadata (username/email, region, did, model, mac) to secrets/vacuum_session.json, mode
0600, gitignored. Later runs reuse that token and need no password at all.

Nothing here moves the vacuum. The vendored library's logging is disabled, and the
password/token are never printed or logged.

Env (via secrets/dreame.env, sourced by run.sh — never hard-coded):
  DREAME_USERNAME   account email/username   (required for the first login; then remembered)
  DREAME_PASSWORD   account password         (required only until a token is stored)
  DREAME_COUNTRY    region code sg/in/eu/us/cn (optional; auto-tries a list)
  DREAME_MAC        target MAC (default dc:ed:83:00:00:00)
"""
from __future__ import annotations

import json
import logging
import os
import pathlib
import sys

logging.disable(logging.CRITICAL)  # honour "don't log": silence the vendored library

HERE = pathlib.Path(__file__).resolve().parent
ADAPTER = HERE.parent
sys.path.insert(0, str(ADAPTER / "vendor"))
SECRETS = ADAPTER.parent.parent / "secrets"          # hearth-devices/secrets (gitignored)
SESSION = SECRETS / "vacuum_session.json"            # token + metadata, NO password
DEVICES = SECRETS / "vacuum_devices.json"            # raw list for later mapping

from dreamehome.protocol import DreameVacuumDreameHomeCloudProtocol  # noqa: E402

SENSITIVE = ("token", "key", "secret", "password", "pwd", "psk", "auth")


def norm_mac(m: str) -> str:
    return "".join(c for c in str(m).lower() if c in "0123456789abcdef")


def load_session() -> dict:
    try:
        return json.loads(SESSION.read_text())
    except Exception:
        return {}


def save_private(path: pathlib.Path, obj) -> None:
    SECRETS.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, default=str))
    path.chmod(0o600)


def device_records(raw) -> list:
    if isinstance(raw, dict):
        page = raw.get("page")
        if isinstance(page, dict) and isinstance(page.get("records"), list):
            return page["records"]
    # fallback: walk for dicts that look like devices
    out, stack = [], [raw]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if "did" in cur and ("mac" in cur or "model" in cur):
                out.append(cur)
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return out


def dev_name(d: dict) -> str:
    return (d.get("customName")
            or (d.get("deviceInfo") or {}).get("displayName")
            or d.get("name") or "?")


def main() -> int:
    sess = load_session()
    user = os.environ.get("DREAME_USERNAME") or sess.get("username")
    pw = os.environ.get("DREAME_PASSWORD")
    token = sess.get("auth_key")
    target = norm_mac(os.environ.get("DREAME_MAC", sess.get("mac") or "dc:ed:83:00:00:00"))

    if not user:
        print("ERROR: no DREAME_USERNAME in env and no stored session. Nothing sent.", file=sys.stderr)
        return 2
    if not token and not pw:
        print("ERROR: no stored token yet, so the first login needs DREAME_PASSWORD in env "
              "(used once, never written). Nothing sent.", file=sys.stderr)
        return 2

    # Region codes the protocol understands (not full country names).
    NAME_TO_CODE = {
        "india": "in", "in": "in", "singapore": "sg", "sg": "sg",
        "europe": "eu", "eu": "eu", "united states": "us", "usa": "us", "us": "us",
        "china": "cn", "cn": "cn", "russia": "ru", "ru": "ru",
    }
    standard = ["sg", "in", "eu", "us", "cn"]
    hint = (os.environ.get("DREAME_COUNTRY") or sess.get("country") or "").strip().lower()
    code = NAME_TO_CODE.get(hint, hint if hint in standard else None)
    if hint and code is None:
        print(f"note: DREAME_COUNTRY={hint!r} isn't a region code; need one of {standard}. "
              "Trying the standard list.")
    # Try the resolved code first (if any), then the rest — deduped — so one run settles region.
    countries = list(dict.fromkeys(([code] if code else []) + standard))

    for country in countries:
        # Prefer the stored token; fall back to the env password if present.
        proto = DreameVacuumDreameHomeCloudProtocol(
            user, pw or "", account_type="dreame", country=country, auth_key=token or None,
        )
        try:
            ok = proto.login()
        except Exception as ex:
            print(f"[{country}] login error: {type(ex).__name__}")
            continue
        if getattr(proto, "verification_url", None) or getattr(proto, "captcha_img", None):
            print(f"[{country}] account needs 2FA/captcha — approve the sign-in in the Dreamehome app, then retry.")
            return 3
        if getattr(proto, "auth_failed", False) or not ok:
            if token and not pw:
                print(f"[{country}] stored token rejected. Re-run once with DREAME_PASSWORD set to refresh it.")
            else:
                print(f"[{country}] auth failed (wrong username/password or wrong region).")
            continue

        how = "stored token" if (token and not pw) else "password (one time)"
        try:
            raw = proto.get_devices()
        except Exception as ex:
            print(f"[{country}] logged in via {how}, but listing devices failed: {type(ex).__name__}")
            raw = None

        recs = device_records(raw) if raw else []
        print(f"[{country}] login OK via {how} — {len(recs)} device(s).")

        match = None
        for d in recs:
            mac = norm_mac(d.get("mac", ""))
            flag = "  <-- target" if mac and mac == target else ""
            if flag:
                match = d
            print(f"  - name={dev_name(d)!r} model={d.get('model','?')} "
                  f"mac={d.get('mac','?')} online={d.get('online', d.get('isOnline','?'))}{flag}")
        # Fall back to the sole device when the target MAC doesn't match (single-vacuum account).
        if match is None and len(recs) == 1:
            match = recs[0]
            print(f"  (no MAC match; using the only device on the account: "
                  f"{dev_name(match)!r} / {match.get('model','?')})")

        # Persist ONLY the revocable token + non-secret metadata. Never the password.
        new_token = getattr(proto, "auth_key", None) or token
        sess_out = {
            "username": user,
            "country": country,
            "auth_key": new_token,            # revocable refresh token, not the password
            "mac": (match or {}).get("mac", sess.get("mac")),
            "did": (match or {}).get("did", sess.get("did")),
            "model": (match or {}).get("model", sess.get("model")),
            "note": "revocable Dreamehome token; no password stored. Change account password to revoke.",
        }
        try:
            save_private(SESSION, sess_out)
            print(f"  token saved to {SESSION} (mode 600, gitignored) — password not stored.")
        except Exception as ex:
            print(f"  WARNING: could not persist token: {type(ex).__name__}")
        if raw:
            try:
                save_private(DEVICES, raw)
            except Exception:
                pass

        if match:
            print(f"\nFound the vacuum. MODEL CODE = {match.get('model','?')}")
            print("Next: map this model's RVC SIID/PIID/AIID for read-only status, then the "
                  "clean/dock action. No command sent yet.")
        else:
            print(f"\nNo device matched MAC {target}. Check DREAME_MAC, or it's on another account.")
        return 0

    print("Could not log in on any region tried. Check credentials / set DREAME_COUNTRY.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
