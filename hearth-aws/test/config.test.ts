import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../lib/config.js';

const root = join(import.meta.dirname, '..');
function withConfig(over: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-cfg-'));
  const base = JSON.parse(JSON.stringify({ hubId: 'laptop', skillId: 'amzn1.ask.skill.x', iotEndpoint: 'abc123-ats.iot.eu-west-1.amazonaws.com', csrPath: join(root, 'test/fixtures/example.csr'), budgetEmail: 'a@b.co' }));
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ ...base, ...over }));
  return () => loadConfig(dir, 'c.json');
}

describe('loadConfig', () => {
  it('loads example.json with defaults and the CSR', () => {
    const c = loadConfig(root, 'config/example.json');
    expect(c).toMatchObject({ hubId: 'laptop', replyTimeoutMs: 3000, locale: 'en-IN' });
    expect(c.csrPem).toContain('BEGIN CERTIFICATE REQUEST');
  });
  it('enforces the contract limits', () => {
    expect(withConfig({ replyTimeoutMs: 6000 })).toThrow(/never above 5000/);
    expect(withConfig({ hubId: 'My_Hub' })).toThrow(/hubId/);
    expect(withConfig({ iotEndpoint: 'example.com' })).toThrow(/iotEndpoint/);
    expect(withConfig({ extra: 1 })).toThrow(/Invalid/);
  });
  it('refuses a csrPath that contains a private key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-csr-'));
    writeFileSync(join(dir, 'bad.csr'), '-----BEGIN CERTIFICATE REQUEST-----\n-----BEGIN EC PRIVATE KEY-----');
    expect(withConfig({ csrPath: join(dir, 'bad.csr') })).toThrow(/private key/);
  });
  it('explains how to start when local.json is missing', () => {
    expect(() => loadConfig(root, 'config/nope.json')).toThrow(/Copy config\/example.json/);
  });
});

describe('certificates config', () => {
  it('requires unique names and at least one active certificate', () => {
    const csrPath = join(root, 'test/fixtures/example.csr');
    expect(withConfig({ certificates: [{ name: 'a', csrPath }, { name: 'a', csrPath }] })).toThrow(/unique/);
    expect(withConfig({ certificates: [{ name: 'a', csrPath, active: false }] })).toThrow(/at least one certificate must be active/);
    expect(withConfig({ certificates: [{ name: 'a', csrPath }, { name: 'b', csrPath, active: false }] })().hubCertificates.map((c) => [c.name, c.active])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });
});
