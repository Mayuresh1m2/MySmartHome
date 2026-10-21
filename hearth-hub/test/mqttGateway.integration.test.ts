/**
 * Hub ↔ hearth-devices over local contract v1, across languages: the in-process bus (same ACLs as Mosquitto
 * will have), the real Python core (`hearth-devices serve`) and fake adapter as processes, and the hub's
 * MqttDeviceGateway + generated tools + pipeline.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startBus, type LocalBus } from '@hearth/local-stack/bus';
import mqtt from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit.js';
import { MqttDeviceGateway } from '../src/devices/mqttGateway.js';
import { createHubMetrics } from '../src/obs/metrics.js';
import { createPipeline } from '../src/pipeline.js';
import { Policy } from '../src/policy/policy.js';
import { StateStore } from '../src/state/store.js';
import { generateDeviceTools } from '../src/tools/deviceTools.js';
import { toolMap } from '../src/tools/index.js';
import type { Tool } from '../src/tools/types.js';
import { fakeFs, silentLog } from './helpers.js';

const devicesDir = resolve(import.meta.dirname, '..', '..', 'hearth-devices');
const USERS = { core: 'c0re', 'adapter-fake': 'f4ke', hub: 'hu8' };
let bus: LocalBus;
let gw: MqttDeviceGateway;
let tmp: string;
const procs: ChildProcess[] = [];

const py = (args: string[], env: Record<string, string>) => {
  const p = spawn('uv', ['run', '-q', ...args], { cwd: devicesDir, env: { ...process.env, ...env }, detached: true, stdio: 'ignore' });
  procs.push(p);
  return p;
};

async function until(cond: () => Promise<boolean> | boolean, ms: number) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'hearth-f2-'));
  bus = await startBus({ users: USERS });
  const port = String(bus.port);
  py(['hearth-devices', 'serve'], { BUS_PORT: port, BUS_PASSWORD: USERS.core, DEVICES_AUDIT_DIR: join(tmp, 'devices-audit') });
  py(['hearth-adapter-fake'], { BUS_PORT: port, BUS_PASSWORD: USERS['adapter-fake'], POLL_INTERVAL_S: '3600' });
  gw = new MqttDeviceGateway({ url: `mqtt://127.0.0.1:${port}`, username: 'hub', password: USERS.hub, log: silentLog, timeoutMs: 5000 });
  await gw.start(1000);
  await until(async () => (await gw.list()).length === 3 && (await gw.getState('fake-lamp')).online, 30_000);
}, 60_000);

afterAll(async () => {
  await gw?.stop();
  for (const p of procs) if (p.pid) try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  await bus?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('hub → hearth-devices core (local contract v1)', () => {
  it('lists devices with capabilities from the registry snapshot', async () => {
    const ids = (await gw.list()).map((d) => d.id).sort();
    expect(ids).toEqual(['fake-lamp', 'fake-lock', 'fake-vacuum']);
    expect((await gw.find('fake lamp'))?.capabilities.map((c) => c.name)).toEqual(['OnOff', 'LevelControl']);
  });

  it('generates voice tools from capabilities, never for the high-risk lock', async () => {
    const names = (await generateDeviceTools(gw)).map((t) => t.name).sort();
    expect(names).toEqual(['device_level_control', 'device_on_off', 'device_rvc_operational_state', 'device_rvc_run_mode']);
  });

  it('a voice command runs end to end, and one requestId appears in both audit logs', async () => {
    const tools = toolMap((await generateDeviceTools(gw)) as Tool[]);
    const policy = Policy.fromObject({ version: 1, voiceRiskCeiling: 'low', tools: { device_on_off: { enabled: true } } });
    const state = new StateStore();
    const hubAudit = new AuditLog(join(tmp, 'hub-audit'), true);
    const handle = createPipeline({
      intent: { name: 'fixed', decide: async () => ({ kind: 'tool', tool: 'device_on_off', args: { device: 'fake lamp', params: { on: true } } }) },
      policy, tools, audit: hubAudit, state, log: silentLog, metrics: createHubMetrics(),
      toolContext: { log: silentLog, state, devices: gw, fs: fakeFs() },
    });
    const requestId = randomUUID();
    const r = await handle({ requestId, text: 'turn on the fake lamp' });
    expect(r.reply).toMatchObject({ status: 'ok', speech: 'Done. The Fake lamp is on.' });
    await hubAudit.flush();
    const read = (dir: string) => readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
    expect(read(join(tmp, 'hub-audit')).find((a) => a.requestId === requestId)).toMatchObject({ tool: 'device_on_off', outcome: 'ok' });
    expect(read(join(tmp, 'devices-audit')).find((a) => a.requestId === requestId)).toMatchObject({ deviceId: 'fake-lamp', via: 'voice', decision: 'sent', ok: true });
    await until(async () => (await gw.getState('fake-lamp')).values.on === true, 5000);
  });

  it('even calling the gateway directly, core refuses the lock: hub requests are voice', async () => {
    const r = await gw.execute('fake-lock', 'DoorLock', { locked: false }, { requestId: randomUUID() });
    expect(r).toEqual({ ok: false, error: 'policy: high risk is never reachable by voice', state: {} });
  });

  it('the hub identity cannot send set to a device itself', async () => {
    const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${bus.port}`, { username: 'hub', password: USERS.hub, protocolVersion: 4, reconnectPeriod: 0 });
    const closed = new Promise<void>((r) => c.once('close', () => r()));
    c.publish('hearth/local/devices/fake-lock/set', JSON.stringify({ v: 1, requestId: 'x', capability: 'DoorLock', action: 'set', params: { locked: false } }), { qos: 1 });
    await closed;
    c.end(true);
    expect((await gw.getState('fake-lock')).values.locked).toBe(true);
  });
});
