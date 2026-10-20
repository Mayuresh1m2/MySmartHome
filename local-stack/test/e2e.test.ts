/**
 * Whole-system test: emulated cloud (broker + rule + DynamoDB + real skill handler) in-process,
 * and the real hearth-hub process spawned against it with a throwaway certificate.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { cloudHubV1 } from '@hearth/contracts';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../src/paths.js';
import { startLocalStack, type LocalStack } from '../src/stack.js';
import { makeTestPki, type TestPki } from '../src/testCerts.js';

const ajv = new Ajv2020({ strict: true });
addFormats.default(ajv);
const validReply = ajv.compile(cloudHubV1.reply);

let pki: TestPki;
let stack: LocalStack;
let hub: ChildProcess | undefined;
let healthPort: number;
let auditDir: string;
let hubEnv: NodeJS.ProcessEnv;
let liveDevice: Server;
const replies: unknown[] = [];
const events: Record<string, unknown>[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

async function waitFor(url: string, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function startHub() {
  hub = spawn('npx', ['tsx', 'src/index.ts'], { cwd: join(repoRoot, 'hearth-hub'), env: hubEnv, detached: true, stdio: 'ignore' });
  return waitFor(`http://127.0.0.1:${healthPort}/ready`);
}

function stopHub() {
  if (hub?.pid) {
    try {
      process.kill(-hub.pid, 'SIGTERM');
    } catch {}
  }
  hub = undefined;
}

beforeAll(async () => {
  pki = makeTestPki();
  const creds = pki.client('hearth-laptop');
  const certsDir = join(pki.dir, 'hubcerts');
  mkdirSync(certsDir);
  renameSync(creds.keyFile, join(certsDir, 'hub.key')); // throwaway test key, laid out like hearth-hub/certs
  auditDir = join(pki.dir, 'audit');

  liveDevice = createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => liveDevice.once('listening', r));
  const devicesFile = join(pki.dir, 'devices.json');
  writeFileSync(
    devicesFile,
    JSON.stringify({
      devices: [
        { id: 'testbox', name: 'test box', aliases: ['testbox'], host: '127.0.0.1', port: (liveDevice.address() as { port: number }).port },
        { id: 'deadbox', name: 'dead box', aliases: ['deadbox'], host: '127.0.0.1', port: await freePort() },
      ],
    }),
  );

  stack = await startLocalStack({
    hubId: 'laptop',
    stateDir: pki.dir,
    replyTimeoutMs: 1500,
    log: (e) => events.push(e),
  });
  stack.broker.onMessage('hearth/laptop/replies', (p) => replies.push(JSON.parse(p.toString())));

  healthPort = await freePort();
  hubEnv = {
    ...process.env,
    HUB_ENV_FILE: '/dev/null',
    IOT_ENDPOINT: 'localhost',
    MQTT_PORT: String(stack.ports.broker),
    MQTT_PROTOCOL_VERSION: '4',
    HUB_ID: 'laptop',
    CERTS_DIR: certsDir,
    CERT_FILE: creds.certFile,
    CA_FILE: pki.caFile,
    HEALTH_PORT: String(healthPort),
    AUDIT_DIR: auditDir,
    DEVICES_FILE: devicesFile,
    LOG_LEVEL: 'warn',
  };
  await startHub();
}, 60000);

afterAll(async () => {
  stopHub();
  await stack?.close();
  liveDevice?.close();
  pki?.cleanup();
});

describe('Alexa → skill → IoT Core → hub → rule → DynamoDB → Alexa (local)', () => {
  it('ping', async () => {
    const r = await stack.say('ping');
    expect(r).toMatchObject({ speech: 'Hub is online.', outcome: 'ok' });
    expect(r.latencyMs).toBeLessThan(1500);
  });

  it('how much space is left', async () => {
    expect((await stack.say('how much space is left')).speech).toMatch(/^You have \d+ gigabytes free out of \d+/);
  });

  it('device checks against real TCP endpoints', async () => {
    expect((await stack.say('is the testbox online')).speech).toBe('The test box is online.');
    expect((await stack.say('is the deadbox online')).speech).toBe('The dead box is not responding.');
  });

  it('refuses what no tool does', async () => {
    expect(await stack.say('unlock the front door')).toMatchObject({ outcome: 'refused', speech: "Sorry, I can't do that." });
  });

  it('every reply on the wire satisfies the shared contract', () => {
    expect(replies.length).toBeGreaterThanOrEqual(5);
    for (const r of replies) expect(validReply(r), JSON.stringify(r)).toBe(true);
  });

  it('one requestId correlates skill log, broker, rule and hub audit', async () => {
    const r = await stack.say('ping');
    const id = r.requestId!;
    await new Promise((res) => setTimeout(res, 100)); // audit is written after the reply
    const audit = readdirSync(auditDir).flatMap((f) => readFileSync(join(auditDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
    expect(audit.some((a) => a.requestId === id && a.tool === 'ping' && a.outcome === 'ok')).toBe(true);
    const seen = new Set(events.filter((e) => e.requestId === id).map((e) => `${e.svc}:${e.evt ?? e.msg}`));
    expect([...seen]).toEqual(expect.arrayContaining(['local-iot:publish', 'local-rule:reply_stored', 'local-skill:command relayed']));
  });

  it('hub off: honest fallback within the reply budget; hub back: answers again', async () => {
    stopHub();
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    const off = await stack.say('ping');
    const took = Date.now() - t0;
    expect(off).toMatchObject({ outcome: 'timeout', speech: "Your home hub didn't answer in time. It might be offline." });
    expect(took).toBeGreaterThanOrEqual(1500);
    expect(took).toBeLessThan(2500);
    await startHub();
    expect((await stack.say('ping')).speech).toBe('Hub is online.');
  }, 60000);
});
