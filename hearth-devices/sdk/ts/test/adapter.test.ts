import { startBus, type LocalBus } from '@hearth/local-stack/bus';
import mqtt from 'mqtt';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AdapterRunner, CommandError, isValid, statePayload, type Adapter, type DeviceMeta, type SetCommand } from '../src/index.js';

const USERS = { core: 'c0re', 'adapter-kit': 'k1t' };
const LAMP = 'hearth/local/devices/ts-lamp';
let bus: LocalBus;
let core: mqtt.MqttClient;
const seen: { topic: string; body: unknown }[] = [];

class KitAdapter implements Adapter {
  readonly adapterId = 'kit';
  readonly pollIntervalMs = 3_600_000;
  on = false;
  async discover(): Promise<DeviceMeta[]> {
    return [
      {
        v: 1, id: 'ts-lamp', name: 'TS lamp', room: 'lab', kind: 'light', adapter: 'kit',
        capabilities: [
          { name: 'OnOff', risk: 'low', params: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } },
          { name: 'Refuse', risk: 'low', params: {} },
          { name: 'Crash', risk: 'low', params: {} },
          { name: 'DoorLock', risk: 'high', params: {} },
        ],
      },
    ];
  }
  async readState() {
    return { on: this.on };
  }
  async execute(_id: string, cmd: SetCommand) {
    if (cmd.capability === 'OnOff') return { on: (this.on = Boolean(cmd.params.on)) };
    if (cmd.capability === 'Refuse') throw new CommandError('lamp refused');
    throw new Error('secret internal detail');
  }
}

const waitFor = async (pred: () => unknown, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const resultFor = (id: string) => seen.find((m) => m.topic === `${LAMP}/result` && (m.body as { requestId?: string }).requestId === id)?.body as Record<string, unknown> | undefined;
const send = (body: unknown) => core.publishAsync(`${LAMP}/set`, typeof body === 'string' ? body : JSON.stringify(body), { qos: 1 });
const cmd = (requestId: string, capability = 'OnOff', params: Record<string, unknown> = {}) => ({ v: 1, requestId, capability, action: 'set', params });

let runner: AdapterRunner;
beforeAll(async () => {
  bus = await startBus({ users: USERS });
  core = await mqtt.connectAsync(`mqtt://127.0.0.1:${bus.port}`, { username: 'core', password: 'c0re', protocolVersion: 4 });
  core.on('message', (topic, p) => {
    let body: unknown = p.toString();
    try {
      body = JSON.parse(p.toString());
    } catch {}
    seen.push({ topic, body });
  });
  await core.subscribeAsync('hearth/local/#', { qos: 1 });
  runner = new AdapterRunner(new KitAdapter(), { port: bus.port, password: 'k1t' }, () => {});
  await runner.start();
});
afterAll(async () => {
  await core.endAsync();
  await bus.close();
});
afterEach(() => void 0);

describe('TS AdapterRunner', () => {
  it('announces online, contract-valid meta and state', async () => {
    await waitFor(() => seen.some((m) => m.topic === `${LAMP}/state`));
    expect(seen.find((m) => m.topic === 'hearth/local/adapters/kit/status')?.body).toBe('online');
    expect(isValid('meta', seen.find((m) => m.topic === `${LAMP}/meta`)?.body)).toBe(true);
    expect(isValid('state', seen.find((m) => m.topic === `${LAMP}/state`)?.body)).toBe(true);
  });

  it('handles set: result ok plus new state', async () => {
    await send(cmd('t-on', 'OnOff', { on: true }));
    await waitFor(() => resultFor('t-on'));
    expect(resultFor('t-on')).toMatchObject({ ok: true, error: null, state: { on: true } });
    expect(isValid('result', resultFor('t-on'))).toBe(true);
  });

  it.each([
    ['t-params', cmd('t-params', 'OnOff', { on: 'yes' }), 'invalid params'],
    ['t-unknown', cmd('t-unknown', 'Teleport'), 'unknown capability Teleport'],
    ['t-high', cmd('t-high', 'DoorLock'), 'high-risk capability is disabled'],
    ['t-refuse', cmd('t-refuse', 'Refuse'), 'lamp refused'],
    ['t-crash', cmd('t-crash', 'Crash'), 'adapter error'],
    ['t-badv', { ...cmd('t-badv'), v: 2 }, 'invalid command'],
  ])('%s becomes a failed result', async (id, body, error) => {
    await send(body);
    await waitFor(() => resultFor(id));
    const r = resultFor(id)!;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(new RegExp(`^${error}`));
    expect(String(r.error)).not.toContain('secret');
    expect(isValid('result', r)).toBe(true);
  });

  it('graceful stop publishes offline', async () => {
    await runner.stop();
    await waitFor(() => seen.filter((m) => m.topic === 'hearth/local/adapters/kit/status').at(-1)?.body === 'offline');
  });

  it('last will: an ungraceful drop is reported offline by the broker', async () => {
    const r2 = new AdapterRunner(new KitAdapter(), { port: bus.port, password: 'k1t' }, () => {});
    await r2.start();
    const statuses = () => seen.filter((m) => m.topic === 'hearth/local/adapters/kit/status').map((m) => m.body);
    await waitFor(() => statuses().at(-1) === 'online');
    const c2 = (r2 as unknown as { client: mqtt.MqttClient }).client;
    c2.options.reconnectPeriod = 0; // keep it down for this test
    c2.stream.destroy(); // no graceful offline
    await waitFor(() => statuses().at(-1) === 'offline');
    await c2.endAsync(true);
  });

  it('re-announces online after the bus drops its session', async () => {
    const r3 = new AdapterRunner(new KitAdapter(), { port: bus.port, password: 'k1t' }, () => {});
    await r3.start();
    const statuses = () => seen.filter((m) => m.topic === 'hearth/local/adapters/kit/status').map((m) => m.body);
    await waitFor(() => statuses().at(-1) === 'online');
    const n = statuses().length;
    // Session takeover: the broker drops r3 (will → offline); r3 reconnects and must say online again.
    const intruder = await mqtt.connectAsync(`mqtt://127.0.0.1:${bus.port}`, { clientId: 'adapter-kit', username: 'adapter-kit', password: 'k1t', protocolVersion: 4, reconnectPeriod: 0 });
    await waitFor(() => statuses().slice(n).includes('offline'));
    await waitFor(() => statuses().at(-1) === 'online' && statuses().slice(n).includes('offline'));
    intruder.end(true);
    await r3.stop();
  });

  it('rejects reserved keys in state values', () => {
    expect(() => statePayload(true, { online: false })).toThrow(/reserved/);
  });
});
