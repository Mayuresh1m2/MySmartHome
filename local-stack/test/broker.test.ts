import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBroker, type LocalBroker } from '../src/broker.js';
import { makeTestPki, type TestPki } from '../src/testCerts.js';

let pki: TestPki;
let broker: LocalBroker;
const events: Record<string, unknown>[] = [];

beforeAll(async () => {
  pki = makeTestPki();
  broker = await startBroker({
    hubId: 'laptop',
    caFile: pki.caFile,
    certFile: pki.serverCert,
    keyFile: pki.serverKey,
    log: (e) => events.push(e),
  });
});
afterAll(async () => {
  await broker.close();
  pki.cleanup();
});

function connect(cn: string, clientId = cn, withCert = true) {
  const creds = withCert ? pki.client(cn) : undefined;
  return mqtt.connect(`mqtts://localhost:${broker.port}`, {
    clientId,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 3000,
    ca: readFileSync(pki.caFile),
    ...(creds ? { key: readFileSync(creds.keyFile), cert: readFileSync(creds.certFile) } : {}),
  });
}

const outcome = (c: mqtt.MqttClient) =>
  new Promise<'connected' | string>((resolve) => {
    c.once('connect', () => resolve('connected'));
    c.once('error', (e) => resolve(e.message));
    c.once('close', () => resolve('closed'));
  });

describe('local IoT Core emulation', () => {
  it('accepts the hub with matching cert CN and client id', async () => {
    const c = connect('hearth-laptop');
    expect(await outcome(c)).toBe('connected');
    c.end(true);
  });

  it('rejects a client id other than hearth-<hubId> (iot:Connect)', async () => {
    const c = connect('hearth-other');
    expect(await outcome(c)).toMatch(/Not authorized|closed/i);
    c.end(true);
  });

  it('rejects the right client id presented with another cert', async () => {
    const c = connect('hearth-other', 'hearth-laptop');
    expect(await outcome(c)).toMatch(/Not authorized|closed/i);
    c.end(true);
  });

  it('rejects a TLS client without a certificate', async () => {
    const c = connect('hearth-laptop', 'hearth-laptop', false);
    expect(await outcome(c)).not.toBe('connected');
    c.end(true);
  });

  it('allows subscribing only to the commands topic', async () => {
    const c = connect('hearth-laptop');
    await outcome(c);
    const ok = await c.subscribeAsync('hearth/laptop/commands', { qos: 1 });
    expect(ok[0]?.qos).toBe(1);
    // mqtt.js 5 turns a SUBACK failure (0x80) into a rejection; the relay must treat it as an error.
    await expect(c.subscribeAsync('hearth/laptop/replies', { qos: 1 })).rejects.toThrow(/Subscribe error/);
    await expect(c.subscribeAsync('hearth/#', { qos: 1 })).rejects.toThrow(/Subscribe error/);
    c.end(true);
  });

  it('delivers cloud commands to the hub and hub replies to the cloud', async () => {
    const c = connect('hearth-laptop');
    await outcome(c);
    await c.subscribeAsync('hearth/laptop/commands', { qos: 1 });
    const got = new Promise<string>((r) => c.on('message', (_t, p) => r(p.toString())));
    const reply = new Promise<string>((r) => broker.onMessage('hearth/laptop/replies', (p) => r(p.toString())));
    await broker.publish('hearth/laptop/commands', '{"hello":1}');
    expect(await got).toBe('{"hello":1}');
    await c.publishAsync('hearth/laptop/replies', '{"reply":1}', { qos: 1 });
    expect(await reply).toBe('{"reply":1}');
    c.end(true);
  });

  it('disconnects a hub that publishes outside its replies topic (iot:Publish)', async () => {
    const c = connect('hearth-laptop');
    await outcome(c);
    const closed = new Promise<void>((r) => c.once('close', () => r()));
    c.publish('hearth/laptop/commands', 'spoof', { qos: 1 });
    await closed;
    expect(events.some((e) => e.evt === 'publish_denied')).toBe(true);
    c.end(true);
  });
});
