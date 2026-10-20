import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { hubRoot } from '../src/config.js';
import { Policy } from '../src/policy/policy.js';

const base = {
  version: 1,
  voiceRiskCeiling: 'medium',
  tools: {
    disk_space: { enabled: true },
    off_tool: { enabled: false },
    list_folder: { enabled: true, ratePerMinute: 2, args: { folder: { enum: ['downloads'] } } },
    lamp: { enabled: true },
    lock: { enabled: true },
  },
};

describe('Policy', () => {
  it('denies tools that are not listed (deny by default)', () => {
    expect(Policy.fromObject(base).check({ name: 'shell', risk: 'read' }, {})).toEqual({ allow: false, reason: 'not_in_policy' });
  });
  it('denies disabled tools', () => {
    expect(Policy.fromObject(base).check({ name: 'off_tool', risk: 'read' }, {})).toMatchObject({ reason: 'disabled' });
  });
  it('allows enabled tools and hands over their settings', () => {
    expect(Policy.fromObject(base).check({ name: 'disk_space', risk: 'read' }, {})).toEqual({ allow: true, settings: {} });
  });
  it('enforces the voice risk ceiling and never allows high', () => {
    const p = Policy.fromObject({ ...base, voiceRiskCeiling: 'low' });
    expect(p.check({ name: 'lamp', risk: 'low' }, {}).allow).toBe(true);
    expect(p.check({ name: 'lamp', risk: 'medium' }, {})).toMatchObject({ reason: 'risk' });
    expect(Policy.fromObject(base).check({ name: 'lock', risk: 'high' }, {})).toMatchObject({ reason: 'risk' });
  });
  it('rejects a ceiling of high in the file itself', () => {
    expect(() => Policy.fromObject({ ...base, voiceRiskCeiling: 'high' })).toThrow(/Invalid policy/);
  });
  it('applies argument constraints', () => {
    const p = Policy.fromObject(base);
    expect(p.check({ name: 'list_folder', risk: 'read' }, { folder: 'downloads' }).allow).toBe(true);
    expect(p.check({ name: 'list_folder', risk: 'read' }, { folder: 'etc' })).toMatchObject({ reason: 'arg_constraint' });
  });
  it('rate limits per tool over a rolling minute', () => {
    let now = 0;
    const p = new Policy(Policy.fromObject(base).file, () => now);
    const call = () => p.check({ name: 'list_folder', risk: 'read' }, { folder: 'downloads' });
    expect(call().allow).toBe(true);
    expect(call().allow).toBe(true);
    expect(call()).toMatchObject({ reason: 'rate_limited' });
    now += 60_001;
    expect(call().allow).toBe(true);
  });
  it('rate limits globally', () => {
    const p = Policy.fromObject({ ...base, globalRatePerMinute: 1 });
    expect(p.check({ name: 'disk_space', risk: 'read' }, {}).allow).toBe(true);
    expect(p.check({ name: 'lamp', risk: 'low' }, {})).toMatchObject({ reason: 'rate_limited' });
  });
  it('rejects unknown keys (typos must not silently enable things)', () => {
    expect(() => Policy.fromObject({ ...base, tools: { disk_space: { enable: true } } })).toThrow(/Invalid policy/);
  });
  it('the shipped config/policy.yaml loads, is read-only by voice and allows only known folders', () => {
    const p = Policy.load(join(hubRoot, 'config', 'policy.yaml'));
    expect(p.file.voiceRiskCeiling).toBe('read');
    expect(p.check({ name: 'list_folder', risk: 'read' }, { folder: 'etc' }).allow).toBe(false);
  });
});
