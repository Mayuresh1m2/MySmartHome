import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GuardedIntent } from '../src/intent/guardedIntent.js';
import { KeywordRouter } from '../src/intent/keywordRouter.js';
import type { IntentEngine } from '../src/intent/types.js';
import { createHubMetrics } from '../src/obs/metrics.js';
import { ThermalGuard, readTemps, type Temps } from '../src/obs/thermal.js';
import { silentLog } from './helpers.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeHwmon(sensors: Record<string, [string, number | string]>) {
  const root = mkdtempSync(join(tmpdir(), 'hwmon-'));
  dirs.push(root);
  for (const [dir, [name, milli]] of Object.entries(sensors)) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'name'), `${name}\n`);
    writeFileSync(join(root, dir, 'temp1_input'), `${milli}\n`);
  }
  return root;
}

describe('readTemps', () => {
  it('reads amdgpu and coretemp, ignores other sensors', async () => {
    const root = fakeHwmon({ hwmon0: ['acpitz', 27000], hwmon1: ['amdgpu', 107000], hwmon2: ['coretemp', 92500], hwmon3: ['iwlwifi', 40000] });
    expect(await readTemps(root)).toEqual({ gpuC: 107, cpuC: 92.5 });
  });
  it('missing sensors or directory read as null', async () => {
    expect(await readTemps(fakeHwmon({ hwmon0: ['acpitz', 27000] }))).toEqual({ gpuC: null, cpuC: null });
    expect(await readTemps('/no/such/dir')).toEqual({ gpuC: null, cpuC: null });
    expect(await readTemps(fakeHwmon({ hwmon0: ['amdgpu', 'garbage'] }))).toEqual({ gpuC: null, cpuC: null });
  });
});

describe('ThermalGuard', () => {
  const make = (t: { v: Temps }, over: Partial<ConstructorParameters<typeof ThermalGuard>[0]> = {}) => {
    let now = 0;
    const g = new ThermalGuard({ gpuMaxC: 95, cpuMaxC: 90, modelCallsPerMinute: 100, read: async () => t.v, now: () => now, cacheMs: 0, ...over });
    return { g, tick: (ms: number) => (now += ms) };
  };

  it('allows below limits and blocks at or above them', async () => {
    const t = { v: { gpuC: 80, cpuC: 70 } as Temps };
    const { g } = make(t);
    expect((await g.check()).allow).toBe(true);
    t.v = { gpuC: 95, cpuC: 70 };
    expect(await g.check()).toMatchObject({ allow: false, reason: 'gpu_hot' });
    t.v = { gpuC: 60, cpuC: 90 };
    expect(await g.check()).toMatchObject({ allow: false, reason: 'cpu_hot' });
  });

  it('hysteresis: once hot, stays off until 5 °C below the limit', async () => {
    const t = { v: { gpuC: 96, cpuC: 50 } as Temps };
    const { g } = make(t);
    await g.check();
    t.v = { gpuC: 92, cpuC: 50 };
    expect(await g.check()).toMatchObject({ allow: false, reason: 'gpu_hot' });
    t.v = { gpuC: 89.9, cpuC: 50 };
    expect((await g.check()).allow).toBe(true);
    expect(g.state).toBe('ok');
  });

  it('no sensors means no thermal block (other machines)', async () => {
    expect((await make({ v: { gpuC: null, cpuC: null } }).g.check()).allow).toBe(true);
  });

  it('rate-limits model calls over a rolling minute', async () => {
    const { g, tick } = make({ v: { gpuC: 50, cpuC: 50 } }, { modelCallsPerMinute: 2 });
    expect((await g.check()).allow).toBe(true);
    expect((await g.check()).allow).toBe(true);
    expect(await g.check()).toMatchObject({ allow: false, reason: 'rate' });
    tick(60_001);
    expect((await g.check()).allow).toBe(true);
  });

  it('caches readings for cacheMs', async () => {
    let reads = 0;
    let now = 0;
    const g = new ThermalGuard({ gpuMaxC: 95, cpuMaxC: 90, modelCallsPerMinute: 100, read: async () => (reads++, { gpuC: 50, cpuC: 50 }), now: () => now, cacheMs: 2000 });
    await g.check();
    await g.check();
    now += 2001;
    await g.check();
    expect(reads).toBe(2);
  });
});

describe('GuardedIntent', () => {
  const model = (fn: () => Promise<never> | ReturnType<IntentEngine['decide']>): IntentEngine & { calls: number } => {
    const m = { name: 'ollama', calls: 0, decide: async () => (m.calls++, fn()) };
    return m;
  };

  it('uses the model when cool', async () => {
    const m = model(async () => ({ kind: 'tool', tool: 'ping', args: {} }));
    const g = new GuardedIntent(m, new KeywordRouter(), new ThermalGuard({ gpuMaxC: 95, cpuMaxC: 90, modelCallsPerMinute: 10, read: async () => ({ gpuC: 60, cpuC: 60 }) }), silentLog);
    expect(await g.decide('anything')).toEqual({ kind: 'tool', tool: 'ping', args: {} });
    expect(m.calls).toBe(1);
  });

  it('when hot, never calls the model and answers with the keyword router', async () => {
    const metrics = createHubMetrics();
    const m = model(async () => ({ kind: 'tool', tool: 'ping', args: {} }));
    const g = new GuardedIntent(m, new KeywordRouter(), new ThermalGuard({ gpuMaxC: 95, cpuMaxC: 90, modelCallsPerMinute: 10, read: async () => ({ gpuC: 108, cpuC: 97 }) }), silentLog, metrics);
    expect(await g.decide('how much space is left')).toEqual({ kind: 'tool', tool: 'disk_space', args: {} });
    expect(await g.decide('unlock the front door')).toMatchObject({ kind: 'refuse' });
    expect(m.calls).toBe(0);
    expect(metrics.intentFallbacks.get({ reason: 'gpu_hot' })).toBe(2);
  });

  it('until the model has warmed up, commands go to the fallback and never queue behind the load', async () => {
    const metrics = createHubMetrics();
    const m = Object.assign(model(async () => ({ kind: 'tool', tool: 'ping', args: {} })), { loaded: false });
    const g = new GuardedIntent(m, new KeywordRouter(), new ThermalGuard({ gpuMaxC: 95, cpuMaxC: 90, modelCallsPerMinute: 10, read: async () => ({ gpuC: 60, cpuC: 60 }) }), silentLog, metrics);
    expect(await g.decide('how much space is left')).toEqual({ kind: 'tool', tool: 'disk_space', args: {} });
    expect(m.calls).toBe(0);
    expect(metrics.intentFallbacks.get({ reason: 'model_loading' })).toBe(1);
    m.loaded = true;
    await g.decide('anything');
    expect(m.calls).toBe(1);
  });

  it('a model failure or timeout falls back instead of failing the command', async () => {
    const metrics = createHubMetrics();
    const m = model(async () => {
      throw new Error('model did not answer within 4300 ms');
    });
    const g = new GuardedIntent(m, new KeywordRouter(), new ThermalGuard({ gpuMaxC: 95, cpuMaxC: 90, modelCallsPerMinute: 10, read: async () => ({ gpuC: 60, cpuC: 60 }) }), silentLog, metrics);
    expect(await g.decide('ping')).toEqual({ kind: 'tool', tool: 'ping', args: {} });
    expect(m.calls).toBe(1); // still only one model call
    expect(metrics.intentFallbacks.get({ reason: 'model_error' })).toBe(1);
  });
});
