import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '..', 'scripts', 'handoff.sh');
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';

/** A stand-in `aws` CLI that answers the three calls handoff.sh makes. */
function setup(opts: { endpoint?: string; pem?: string; certOutput?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-handoff-'));
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(dir, 'aws.log');
  const desc = JSON.stringify({ certificateDescription: { status: 'ACTIVE', certificatePem: opts.pem ?? PEM } });
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env bash
echo "$*" >> ${log}
case "$1 $2" in
  "cloudformation describe-stacks") echo "${opts.certOutput ?? 'abcdef0123456789'}" ;;
  "iot describe-endpoint") echo "${opts.endpoint ?? 'abc123-ats.iot.eu-west-1.amazonaws.com'}" ;;
  "iot describe-certificate") echo '${desc}' ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(join(bin, 'aws'), 0o755);
  const config = join(dir, 'local.json');
  writeFileSync(config, JSON.stringify({ hubId: 'laptop', iotEndpoint: 'abc123-ats.iot.eu-west-1.amazonaws.com' }));
  const out = join(dir, 'out');
  const run = (...args: string[]) =>
    spawnSync('bash', [script, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HEARTH_CONFIG: config, OUT_DIR: out }, encoding: 'utf8' });
  return { run, out, log };
}

describe('scripts/handoff.sh', () => {
  it('writes hub.crt and hub.env from the stack output and the certificate PEM', () => {
    const s = setup();
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(s.out, 'hub.crt'), 'utf8').trim()).toBe(PEM);
    expect(readFileSync(join(s.out, 'hub.env'), 'utf8')).toBe('IOT_ENDPOINT=abc123-ats.iot.eu-west-1.amazonaws.com\nHUB_ID=laptop\nAWS_REGION=eu-west-1\n');
    const calls = readFileSync(s.log, 'utf8');
    expect(calls).toContain("OutputKey=='HubCertificateId'");
    expect(calls).toContain('--region eu-west-1');
    expect(calls).not.toMatch(/create-keys|create-certificate|update-certificate|delete/);
  });

  it('writes hub-<name>.crt for a rotation certificate', () => {
    const s = setup();
    expect(s.run('next').status).toBe(0);
    expect(existsSync(join(s.out, 'hub-next.crt'))).toBe(true);
    expect(readFileSync(s.log, 'utf8')).toContain("OutputKey=='HubCertificateIdnext'");
  });

  it('refuses when the account endpoint differs from config', () => {
    const r = setup({ endpoint: 'other-ats.iot.eu-west-1.amazonaws.com' }).run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/differs/);
  });

  it('refuses when the certificate is not deployed', () => {
    const r = setup({ certOutput: 'None' }).run('ghost');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no output HubCertificateIdghost/);
  });

  it('refuses a response containing a private key', () => {
    const r = setup({ pem: `${PEM}\\n-----BEGIN EC PRIVATE KEY-----` }).run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/private key/);
  });
});
