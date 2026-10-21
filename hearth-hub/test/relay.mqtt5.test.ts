/**
 * The relay over MQTT 5 against the Mosquitto IoT emulator (mTLS, identity = cert CN, ACL = IoT policy).
 * Opt-in: HEARTH_TEST_IOT_PORT=8893 (start it with local-stack/scripts/iot-mosquitto.sh up). Uses throwaway
 * certificates signed by the local CA; never the real hub key.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import mqtt from 'mqtt';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/obs/log.js';
import { createHubMetrics, type HubMetrics } from '../src/obs/metrics.js';
import { Relay } from '../src/relay/relay.js';
import { ReplyV1, makeReply } from '../src/relay/schema.js';

const port = Number(process.env.HEARTH_TEST_IOT_PORT ?? 0);
const stack = resolve(import.meta.dirname, '..', '..', 'local-stack');
const iot = join(stack, '.state', 'iot');
let dir: string;
let cloud: mqtt.MqttClient;
let relay: Relay | undefined;
let metrics: HubMetrics;
const replies: unknown[] = [];

function issue(cn: string) {
  const key = join(dir, `${cn}.key`);
  const csr = join(dir, `${cn}.csr`);
  const crt = join(dir, `${cn}.crt`);
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key], { stdio: 'pipe' });
  execFileSync('openssl', ['req', '-new', '-key', key, '-subj', `/CN=${cn}`, '-out', csr], { stdio: 'pipe' });
  execFileSync('bash', [join(stack, 'scripts', 'local-ca.sh'), 'sign', csr, crt], { stdio: 'pipe' });
  return { key, crt };
}

const tls = (c: { key: string; crt: string }) => ({ key: readFileSync(c.key), cert: readFileSync(c.crt), ca: readFileSync(join(iot, 'ca.crt')) });
const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!port)('relay over MQTT 5 against Mosquitto (IoT Core emulator)', () => {
  let hub: { key: string; crt: string };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hearth-mqtt5-'));
    hub = issue('hearth-laptop');
    cloud = await mqtt.connectAsync({ protocol: 'mqtts', host: 'localhost', port, protocolVersion: 5, clientId: 'ignored', ...tls({ key: join(iot, 'cloud.key'), crt: join(iot, 'cloud.crt') }) });
    cloud.on('message', (_t, p) => replies.push(JSON.parse(p.toString())));
    await cloud.subscribeAsync('hearth/laptop/replies', { qos: 1 });
  });
  afterAll(async () => {
    await cloud?.endAsync();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    await relay?.stop();
    relay = undefined;
    replies.length = 0;
  });

  function start() {
    metrics = createHubMetrics();
    relay = new Relay(
      {
        host: 'localhost', port, protocolVersion: 5, clientId: 'hearth-laptop',
        commandsTopic: 'hearth/laptop/commands', repliesTopic: 'hearth/laptop/replies',
        keyPath: hub.key, certPath: hub.crt, caPath: join(iot, 'ca.crt'), minBackoffMs: 100, maxBackoffMs: 800,
      },
      { onCommand: async (cmd) => makeReply(cmd.requestId, 'Hub is online.', 'ok') },
      createLogger('silent'),
      metrics,
    );
    relay.start();
    return relay;
  }

  it('connects with MQTT 5, subscribes, and answers a command with a contract-valid reply', async () => {
    const r = start();
    await until(() => r.status.state === 'connected');
    const requestId = randomUUID();
    await cloud.publishAsync('hearth/laptop/commands', JSON.stringify({ v: 1, requestId, text: 'ping', sentAt: Date.now() }), { qos: 1 });
    await until(() => replies.length === 1);
    expect(ReplyV1.parse(replies[0])).toMatchObject({ requestId, speech: 'Hub is online.', status: 'ok' });
  });

  it('the IoT policy holds: the hub cannot publish to its commands topic (PUBACK 0x87)', async () => {
    const c = await mqtt.connectAsync({ protocol: 'mqtts', host: 'localhost', port, protocolVersion: 5, clientId: 'hearth-laptop', reconnectPeriod: 0, ...tls(hub) });
    await expect(c.publishAsync('hearth/laptop/commands', 'spoof', { qos: 1 })).rejects.toThrow();
    await c.endAsync(true);
  });

  it('a certificate for another hub receives nothing and can publish nothing', async () => {
    const other = await mqtt.connectAsync({ protocol: 'mqtts', host: 'localhost', port, protocolVersion: 5, clientId: 'x', reconnectPeriod: 0, ...tls(issue('hearth-other')) });
    const got: string[] = [];
    other.on('message', (t) => got.push(t));
    await other.subscribeAsync('hearth/laptop/commands', { qos: 1 }).catch(() => undefined);
    await cloud.publishAsync('hearth/laptop/commands', JSON.stringify({ v: 1, requestId: randomUUID(), text: 'ping', sentAt: Date.now() }), { qos: 1 });
    await expect(other.publishAsync('hearth/laptop/replies', '{}', { qos: 1 })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toEqual([]);
    await other.endAsync(true);
  });

  it('a client without a certificate is refused at the TLS layer', async () => {
    const c = mqtt.connect({ protocol: 'mqtts', host: 'localhost', port, protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 3000, ca: readFileSync(join(iot, 'ca.crt')) });
    const outcome = await new Promise<string>((r) => {
      c.once('connect', () => r('connected'));
      c.once('error', () => r('refused'));
      c.once('close', () => r('refused'));
    });
    expect(outcome).toBe('refused');
    c.end(true);
  });

  it('reconnects and resubscribes after the broker restarts', async () => {
    const r = start();
    await until(() => r.status.state === 'connected');
    execFileSync('docker', ['compose', '-f', join(stack, 'deploy', 'compose.yaml'), 'restart', 'iot'], { env: { ...process.env, HOST_UID: String(process.getuid?.()), HOST_GID: String(process.getgid?.()) }, stdio: 'pipe' });
    await until(() => metrics.reconnects.get() >= 1, 15_000);
    await until(() => r.status.state === 'connected', 15_000);
    await until(() => cloud.connected, 15_000);
    await cloud.subscribeAsync('hearth/laptop/replies', { qos: 1 });
    const requestId = randomUUID();
    await cloud.publishAsync('hearth/laptop/commands', JSON.stringify({ v: 1, requestId, text: 'ping', sentAt: Date.now() }), { qos: 1 });
    await until(() => replies.some((x) => (x as { requestId: string }).requestId === requestId), 8000);
  }, 40_000);
});
