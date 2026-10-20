import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuditLog } from '../src/audit/audit.js';
import { JsonDeviceGateway } from '../src/devices/jsonGateway.js';
import type { DeviceGateway } from '../src/devices/gateway.js';
import { KeywordRouter } from '../src/intent/keywordRouter.js';
import type { Decision, IntentEngine } from '../src/intent/types.js';
import { createHubMetrics } from '../src/obs/metrics.js';
import { createPipeline } from '../src/pipeline.js';
import { Policy } from '../src/policy/policy.js';
import { StateStore } from '../src/state/store.js';
import { generateDeviceTools, toolNameFor } from '../src/tools/deviceTools.js';
import { allTools, toolMap } from '../src/tools/index.js';
import type { Tool } from '../src/tools/types.js';
import { FakeGateway } from './fakeGateway.js';
import { devicesFixture, fakeFs, silentLog } from './helpers.js';

const KEYS = ['r1', 'r2', 'r3', 'a', 'b', 'c', 'd', 'req'] as const;
const ID = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<(typeof KEYS)[number], string>;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const gateways: [string, () => DeviceGateway][] = [
  ['JsonDeviceGateway', () => new JsonDeviceGateway(devicesFixture, async (h) => h === '10.0.0.1')],
  ['FakeGateway', () => new FakeGateway()],
];

describe.each(gateways)('%s satisfies the DeviceGateway contract', (_name, make) => {
  it('lists devices with capabilities and finds them by name or alias', async () => {
    const g = make();
    const list = await g.list();
    expect(list.length).toBeGreaterThan(0);
    for (const d of list) {
      expect(d.id).toMatch(/^[a-z0-9-]+$/);
      expect(Array.isArray(d.capabilities)).toBe(true);
      expect(await g.find(d.name.toUpperCase())).toMatchObject({ id: d.id });
      expect(await g.find(`the ${d.name}`)).toMatchObject({ id: d.id });
    }
    expect(await g.find('no such device')).toBeUndefined();
  });

  it('reports state with an online flag', async () => {
    const g = make();
    for (const d of await g.list()) expect(typeof (await g.getState(d.id)).online).toBe('boolean');
  });
});

describe('generated device tools', () => {
  it('one tool per capability; high risk and reachability never become tools', async () => {
    const tools = await generateDeviceTools(new FakeGateway());
    expect(tools.map((t) => [t.name, t.risk])).toEqual([
      ['device_on_off', 'low'],
      ['device_level_control', 'low'],
      ['device_rvc_run_mode', 'medium'],
    ]);
    expect(await generateDeviceTools(new JsonDeviceGateway(devicesFixture))).toEqual([]);
  });

  it('names follow the capability', () => {
    expect(toolNameFor('OnOff')).toBe('device_on_off');
    expect(toolNameFor('RvcOperationalState')).toBe('device_rvc_operational_state');
  });

  it('params are validated with the capability JSON Schema and export back for the model', async () => {
    const [onOff] = await generateDeviceTools(new FakeGateway());
    expect(onOff!.args.safeParse({ device: 'lamp', params: { on: true } }).success).toBe(true);
    expect(onOff!.args.safeParse({ device: 'lamp', params: { on: 'yes' } }).success).toBe(false);
    expect(onOff!.args.safeParse({ device: 'lamp', params: { on: true, extra: 1 } }).success).toBe(false);
    expect(z.toJSONSchema(onOff!.args)).toMatchObject({ type: 'object', properties: { params: { properties: { on: { type: 'boolean' } } } } });
  });
});

/** Builds the hub exactly as app.ts does, with any gateway and intent. No intent/tool module knows which gateway. */
async function hub(devices: DeviceGateway, decision: Decision | null, policyTools: Record<string, object>) {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-gw-'));
  dirs.push(dir);
  const policy = Policy.fromObject({ version: 1, voiceRiskCeiling: 'medium', tools: policyTools });
  const enabled = new Set(policy.enabledTools());
  const tools = toolMap([...allTools, ...(await generateDeviceTools(devices)).filter((t) => enabled.has(t.name))] as Tool[]);
  const intent: IntentEngine = decision ? { name: 'fixed', decide: async () => decision } : new KeywordRouter();
  const state = new StateStore();
  return createPipeline({
    intent, policy, tools, audit: new AuditLog(dir, true), state, log: silentLog, metrics: createHubMetrics(),
    toolContext: { log: silentLog, state, devices, fs: fakeFs() },
  });
}

describe('M5: the gateway is swappable without touching intent or tools', () => {
  it('is_device_online works unchanged against both gateways', async () => {
    const real = await hub(new JsonDeviceGateway(devicesFixture, async () => true), null, { is_device_online: { enabled: true } });
    const fake = await hub(new FakeGateway(), null, { is_device_online: { enabled: true } });
    expect((await real({ requestId: ID.r1, text: 'is the router online' })).reply.speech).toBe('The router is online.');
    expect((await fake({ requestId: ID.r2, text: 'is the lamp online' })).reply.speech).toBe('The desk lamp is online.');
    expect((await fake({ requestId: ID.r3, text: 'is the front door lock online' })).reply.speech).toBe('The front door lock is not responding.');
  });

  it('a generated device tool executes through the gateway with the command requestId', async () => {
    const gw = new FakeGateway();
    const run = await hub(gw, { kind: 'tool', tool: 'device_on_off', args: { device: 'the light', params: { on: true } } }, { device_on_off: { enabled: true } });
    const r = await run({ requestId: ID.req, text: 'turn on the light' });
    expect(r.reply).toMatchObject({ status: 'ok', speech: 'Done. The desk lamp is on.' });
    expect(gw.calls).toEqual([{ id: 'lamp', capability: 'OnOff', params: { on: true }, requestId: ID.req }]);
  });

  it('device tools are refused unless policy enables them, and above the voice ceiling', async () => {
    const gw = new FakeGateway();
    const notListed = await hub(gw, { kind: 'tool', tool: 'device_on_off', args: { device: 'lamp', params: { on: true } } }, { ping: { enabled: true } });
    expect((await notListed({ requestId: ID.a, text: 'x' })).decision).toBe('refused:unknown_tool'); // filtered out entirely
    const lowCeiling = await (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hearth-gw-'));
      dirs.push(dir);
      const policy = Policy.fromObject({ version: 1, voiceRiskCeiling: 'low', tools: { device_rvc_run_mode: { enabled: true } } });
      const tools = toolMap([...(await generateDeviceTools(gw))] as Tool[]);
      const state = new StateStore();
      return createPipeline({
        intent: { name: 'fixed', decide: async () => ({ kind: 'tool', tool: 'device_rvc_run_mode', args: { device: 'vacuum', params: { mode: 'cleaning' } } }) },
        policy, tools, audit: new AuditLog(dir, true), state, log: silentLog, metrics: createHubMetrics(),
        toolContext: { log: silentLog, state, devices: gw, fs: fakeFs() },
      });
    })();
    expect((await lowCeiling({ requestId: ID.b, text: 'x' })).decision).toBe('refused:risk');
    expect(gw.calls).toHaveLength(0);
  });

  it('gateway errors are spoken plainly; bad params never reach the gateway', async () => {
    const gw = new FakeGateway();
    gw.state.lamp!.online = false;
    const off = await hub(gw, { kind: 'tool', tool: 'device_on_off', args: { device: 'lamp', params: { on: true } } }, { device_on_off: { enabled: true } });
    expect((await off({ requestId: ID.c, text: 'x' })).reply.speech).toBe("The desk lamp couldn't do that: device is offline.");
    const bad = await hub(gw, { kind: 'tool', tool: 'device_on_off', args: { device: 'lamp', params: { on: 'maybe' } } }, { device_on_off: { enabled: true } });
    expect((await bad({ requestId: ID.d, text: 'x' })).decision).toBe('refused:bad_args');
    expect(gw.calls.map((c) => c.requestId)).toEqual([ID.c]);
  });
});
