import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../lib/config.js';

const root = join(import.meta.dirname, '..');
const fixture = 'test/fixtures/test.env';
const csrPath = join(root, 'test/fixtures/example.csr');

/** Loads the fixture with some variables overridden (as real environment variables would). */
const withEnv = (env: Record<string, string>) => () => loadConfig(root, { envFile: fixture, env });

describe('loadConfig (.env)', () => {
  it('loads the fixture env file with defaults and the CSR', () => {
    const c = withEnv({})();
    expect(c).toMatchObject({ hubId: 'laptop', region: 'ap-southeast-2', replyTimeoutMs: 5000, locale: 'en-IN', budgetEmail: 'you@example.com', hearthKillSwitchUsd: 1, accountKillSwitchUsd: 5, debugUtterances: false });
    expect(c.csrPem).toContain('BEGIN CERTIFICATE REQUEST');
  });

  it('real environment variables override the file', () => {
    expect(withEnv({ HEARTH_KILL_SWITCH_USD: '2.5', HEARTH_DEBUG_UTTERANCES: 'true' })()).toMatchObject({ hearthKillSwitchUsd: 2.5, debugUtterances: true });
  });

  it('enforces the contract limits and names the variable to fix', () => {
    expect(withEnv({ HEARTH_REPLY_TIMEOUT_MS: '6000' })).toThrow(/HEARTH_REPLY_TIMEOUT_MS: contract: never above 5000/);
    expect(withEnv({ HEARTH_HUB_ID: 'My_Hub' })).toThrow(/HEARTH_HUB_ID/);
    expect(withEnv({ HEARTH_IOT_ENDPOINT: 'example.com' })).toThrow(/HEARTH_IOT_ENDPOINT/);
    expect(withEnv({ HEARTH_ALERT_EMAIL: 'not-an-email' })).toThrow(/HEARTH_ALERT_EMAIL/);
    expect(withEnv({ HEARTH_AWS_REGION: 'Sydney' })).toThrow(/HEARTH_AWS_REGION/);
  });

  it('the IoT endpoint must be in the configured region', () => {
    expect(withEnv({ HEARTH_AWS_REGION: 'us-east-2' })).toThrow(/is not in HEARTH_AWS_REGION=us-east-2/);
    expect(withEnv({ HEARTH_AWS_REGION: 'us-east-2', HEARTH_IOT_ENDPOINT: 'abc123-ats.iot.us-east-2.amazonaws.com' })().region).toBe('us-east-2');
  });

  it('a missing skill id or email is reported, not silently defaulted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-env-'));
    writeFileSync(join(dir, '.env'), `HEARTH_AWS_REGION=ap-southeast-2\nHEARTH_IOT_ENDPOINT=abc-ats.iot.ap-southeast-2.amazonaws.com\nHEARTH_CSR_PATH=${csrPath}\nHEARTH_SKILL_ID=\n`);
    expect(() => loadConfig(root, { envFile: join(dir, '.env'), env: {} })).toThrow(/HEARTH_SKILL_ID[\s\S]*HEARTH_ALERT_EMAIL|HEARTH_ALERT_EMAIL[\s\S]*HEARTH_SKILL_ID/);
  });

  it('refuses a CSR path that contains a private key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-csr-'));
    writeFileSync(join(dir, 'bad.csr'), '-----BEGIN CERTIFICATE REQUEST-----\n-----BEGIN EC PRIVATE KEY-----');
    expect(withEnv({ HEARTH_CSR_PATH: join(dir, 'bad.csr') })).toThrow(/private key/);
  });

  it('explains how to start when .env is missing', () => {
    expect(() => loadConfig(root, { envFile: '/no/such/.env', env: {} })).toThrow(/Copy .env.example to .env/);
  });
});

describe('certificates (HEARTH_CERTIFICATES)', () => {
  it('requires unique names and at least one active certificate', () => {
    const certs = (v: unknown) => withEnv({ HEARTH_CERTIFICATES: JSON.stringify(v) });
    expect(certs([{ name: 'a', csrPath }, { name: 'a', csrPath }])).toThrow(/unique/);
    expect(certs([{ name: 'a', csrPath, active: false }])).toThrow(/at least one certificate must be active/);
    expect(certs([{ name: 'a', csrPath }, { name: 'b', csrPath, active: false }])().hubCertificates.map((c) => [c.name, c.active])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(withEnv({ HEARTH_CERTIFICATES: 'not json' })).toThrow(/must be JSON/);
  });
});
