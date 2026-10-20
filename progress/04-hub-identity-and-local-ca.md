# 04 — Hub identity and the local CA (PLAN B2)

Date: 2026-10-21

## Goal

Create the hub's real identity (key and CSR) and a local CA that issues a cert from the **same CSR**, so the mTLS path is exercised locally exactly as it will be against IoT Core.

## `hearth-hub/scripts/make-csr.sh`

- **ECDSA P-256** key (supported by IoT Core `CreateCertificateFromCsr`, and cheap on this CPU), written under `umask 077`, then `chmod 600`. `certs/` is `chmod 700`.
- CSR subject `CN=hearth-<hubId>, O=Hearth`.
- Downloads Amazon Root CA 1 from amazontrust.com, unless `--skip-ca`.
- **Refuses to overwrite an existing key.** For rotation, `--dir certs/next` creates a second key and CSR alongside the live one, matching the runbook's "new CSR, new cert, switch, then deactivate" order.
- Validates the hubId format.
- Prints the absolute CSR path for `hearth-aws/config/local.json`.

The script is the only thing that ever touches `hub.key`. In the hub code, the key path is passed to the TLS options only (see B3).

## `local-stack/scripts/local-ca.sh`

- `init`: local CA (P-256, `CA:TRUE`) and a broker server cert for `localhost` / `127.0.0.1` (serverAuth).
- `sign <csr> <out>`: verifies the CSR's self-signature, requires `CN=hearth-<hubId>`, and issues a 1-year clientAuth cert. It reads only the CSR.
- All state lives in `local-stack/.state/` (gitignored).

`config.ts` gained `CERT_FILE` so the hub can use `local-stack/.state/hub-local.crt` locally, with the same `certs/hub.key`. `config/hub.example.env` is committed.

## Evidence

```text
$ hearth-hub/scripts/make-csr.sh
Downloaded Amazon Root CA 1.
Key:  .../hearth-hub/certs/hub.key (mode 600, stays on this machine)
CSR:  .../hearth-hub/certs/hub.csr
CSR subject: subject=CN=hearth-laptop, O=Hearth
Put this absolute path in hearth-aws/config/local.json as "csrPath":
  ~/workspace/MySmartHome/hearth-hub/certs/hub.csr

$ make-csr.sh            # second run
Refusing to overwrite existing .../certs/hub.key.          exit=1
$ make-csr.sh --hub-id Bad_ID
hubId must be lowercase letters, digits and hyphens        exit=2

$ stat -c '%a %n' certs/*
664 certs/AmazonRootCA1.pem
644 certs/hub.csr
600 certs/hub.key

$ local-stack/scripts/local-ca.sh init && local-ca.sh sign certs/hub.csr ../local-stack/.state/hub-local.crt
created local CA / created broker server cert
Certificate request self-signature verify OK
issued ../local-stack/.state/hub-local.crt for hearth-laptop (C7:F8:9D:4A:B9:72:01:C5...)
$ openssl verify -CAfile .state/ca/ca.crt .state/hub-local.crt
.state/hub-local.crt: OK         EKU: TLS Web Client Authentication
Amazon Root CA 1 notAfter=Jan 17 00:00:00 2038 GMT

$ git check-ignore -v hearth-hub/certs/hub.key local-stack/.state/ca/ca.key
.gitignore:19:hearth-hub/certs/     hearth-hub/certs/hub.key
.gitignore:26:local-stack/.state/   local-stack/.state/ca/ca.key
```

## Notes

- `csrPath` for hearth-aws: `~/workspace/MySmartHome/hearth-hub/certs/hub.csr`
- This CSR is the production one. hearth-aws M2 creates the IoT certificate from it, so the key never needs to change between local and cloud.
