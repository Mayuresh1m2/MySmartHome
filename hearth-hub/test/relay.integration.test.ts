import { randomUUID } from 'node:crypto';
import { startBroker, type LocalBroker } from '@hearth/local-stack';
import { makeTestPki, type TestPki } from '@hearth/local-stack/test-certs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/obs/log.js';
import { createHubMetrics, type HubMetrics } from '../src/obs/metrics.js';
import { Relay } from '../src/relay/relay.js';
import { ReplyV1, makeReply } from '../src/relay/schema.js';

let pki: TestPki;
let broker: LocalBroker;
let hubCreds: { keyFile: string; certFile: string };
let relay: Relay | undefined;
let metrics: HubMetrics;
const replies: unknown[] = [];

async function newBroker(port = 0) {
  broker = await startBroker({ hubId: 'laptop', port, caFile: pki.caFile, certFile: pki.serverCert, keyFile: pki.serverKey });
  broker.onMessage('hearth/laptop/replies', (p) => replies.push(JSON.parse(p.toString())));
}

beforeAll(async () => {
  pki = makeTestPki();
  hubCreds = pki.client('hearth-laptop');
  await newBroker();
});
afterAll(async () => {
  await broker.close();
  pki.cleanup();
});
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
  replies.length = 0;
});

function startRelay() {
  metrics = createHubMetrics();
  relay = new Relay(
    {
      host: 'localhost',
      port: broker.port,
      protocolVersion: 4,
      clientId: 'hearth-laptop',
      commandsTopic: 'hearth/laptop/commands',
      repliesTopic: 'hearth/laptop/replies',
      keyPath: hubCreds.keyFile,
      certPath: hubCreds.certFile,
      caPath: pki.caFile,
      minBackoffMs: 50,
      maxBackoffMs: 400,
    },
    { onCommand: async (cmd) => makeReply(cmd.requestId, 'Hub is online.', 'ok') },
    createLogger('silent'),
    metrics,
  );
  relay.start();
  return relay;
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const command = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, requestId: randomUUID(), text: 'ping', sentAt: Date.now(), ...over });

describe('relay against the local IoT Core emulator', () => {
  it('connects, subscribes and answers a command with a contract-valid reply', async () => {
    const r = startRelay();
    await until(() => r.status.state === 'connected');
    const payload = command();
    await broker.publish('hearth/laptop/commands', payload);
    await until(() => replies.length === 1);
    const reply = ReplyV1.parse(replies[0]);
    expect(reply).toMatchObject({ requestId: JSON.parse(payload).requestId, speech: 'Hub is online.', status: 'ok' });
    expect(metrics.mqttConnected.get()).toBe(1);
  });

  it('drops malformed, wrong-version, stale and duplicate commands without replying', async () => {
    const r = startRelay();
    await until(() => r.status.state === 'connected');
    const dup = command();
    await broker.publish('hearth/laptop/commands', 'not json');
    await broker.publish('hearth/laptop/commands', command({ v: 2 }));
    await broker.publish('hearth/laptop/commands', command({ extra: true }));
    await broker.publish('hearth/laptop/commands', command({ sentAt: Date.now() - 11_000 }));
    await broker.publish('hearth/laptop/commands', dup);
    await broker.publish('hearth/laptop/commands', dup);
    await until(() => replies.length === 1);
    await new Promise((res) => setTimeout(res, 200));
    expect(replies).toHaveLength(1);
    for (const outcome of ['not_json', 'wrong_version', 'invalid', 'stale', 'duplicate']) {
      expect(metrics.commands.get({ outcome }), outcome).toBe(1);
    }
  });

  it('reconnects and resubscribes after the connection drops', async () => {
    const r = startRelay();
    await until(() => r.status.state === 'connected');
    broker.dropClients();
    await until(() => r.status.state !== 'connected');
    await until(() => r.status.state === 'connected');
    expect(metrics.reconnects.get()).toBeGreaterThanOrEqual(1);
    await broker.publish('hearth/laptop/commands', command());
    await until(() => replies.length === 1);
  });

  it('backs off while the broker is down and recovers when it returns', async () => {
    const r = startRelay();
    await until(() => r.status.state === 'connected');
    const port = broker.port;
    await broker.close();
    await until(() => metrics.reconnects.get() >= 3, 8000);
    expect(r.status.state).not.toBe('connected');
    await newBroker(port);
    await until(() => r.status.state === 'connected', 8000);
    await broker.publish('hearth/laptop/commands', command());
    await until(() => replies.length === 1);
  });
});
