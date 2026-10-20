import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { cloudHubV1 } from '@hearth/contracts';
import { describe, expect, it } from 'vitest';
import type { CommandPublisher, CommandV1, ReplyStore } from '../src/ports.js';
import { clampTimeout, relayCommand } from '../src/relay.js';

const ajv = new Ajv2020({ strict: true });
addFormats.default(ajv);
const validCommand = ajv.compile(cloudHubV1.command);

/** A fake hub: records published commands and answers through the store after a delay. */
function fakeHub(answer?: (cmd: CommandV1) => Record<string, unknown> | undefined, delayMs = 50) {
  const sent: { topic: string; cmd: CommandV1 }[] = [];
  const table = new Map<string, Record<string, unknown>>();
  const publisher: CommandPublisher = {
    async publish(topic, cmd) {
      sent.push({ topic, cmd });
      const item = answer?.(cmd);
      if (item) setTimeout(() => table.set(cmd.requestId, item), delayMs);
    },
  };
  const replies: ReplyStore = { get: async (id) => table.get(id) };
  return { sent, publisher, replies };
}

const cfg = { hubId: 'laptop', replyTimeoutMs: 600, pollIntervalMs: 20 };

describe('relayCommand', () => {
  it('publishes a contract-valid command to the hub topic and returns the reply', async () => {
    const hub = fakeHub((c) => ({ v: 1, requestId: c.requestId, speech: 'Hub is online.', status: 'ok' }));
    const r = await relayCommand('ping', cfg, hub.publisher, hub.replies);
    expect(r).toMatchObject({ outcome: 'ok', reply: { speech: 'Hub is online.' } });
    expect(hub.sent[0]?.topic).toBe('hearth/laptop/commands');
    expect(validCommand(hub.sent[0]?.cmd)).toBe(true);
    expect(r.latencyMs).toBeLessThan(cfg.replyTimeoutMs);
  });

  it('passes refused and error statuses through', async () => {
    const hub = fakeHub((c) => ({ v: 1, requestId: c.requestId, speech: 'No.', status: 'refused', expiresAt: 1 }));
    expect((await relayCommand('x', cfg, hub.publisher, hub.replies)).outcome).toBe('refused');
  });

  it('times out honestly when the hub is silent, close to the configured budget', async () => {
    const hub = fakeHub();
    const t0 = Date.now();
    const r = await relayCommand('ping', cfg, hub.publisher, hub.replies);
    const took = Date.now() - t0;
    expect(r.outcome).toBe('timeout');
    expect(took).toBeGreaterThanOrEqual(cfg.replyTimeoutMs - 5);
    expect(took).toBeLessThan(cfg.replyTimeoutMs + 150);
  });

  it('flags replies that break the contract', async () => {
    const hub = fakeHub((c) => ({ v: 2, requestId: c.requestId, speech: 'x', status: 'ok' }));
    expect((await relayCommand('x', cfg, hub.publisher, hub.replies)).outcome).toBe('bad_reply');
    const hub2 = fakeHub((c) => ({ v: 1, requestId: c.requestId, speech: 'x', status: 'maybe' }));
    expect((await relayCommand('x', cfg, hub2.publisher, hub2.replies)).outcome).toBe('bad_reply');
  });

  it('reports publish failures', async () => {
    const r = await relayCommand('x', cfg, { publish: async () => { throw new Error('denied'); } }, { get: async () => undefined });
    expect(r.outcome).toBe('publish_failed');
  });

  it('survives transient read errors while polling', async () => {
    let calls = 0;
    const hub = fakeHub((c) => ({ v: 1, requestId: c.requestId, speech: 'ok', status: 'ok' }));
    const flaky: ReplyStore = { get: async (id) => (++calls < 3 ? Promise.reject(new Error('throttled')) : hub.replies.get(id)) };
    expect((await relayCommand('x', cfg, hub.publisher, flaky)).outcome).toBe('ok');
  });
});

describe('clampTimeout', () => {
  it('defaults to 3000 and never exceeds 5000', () => {
    expect(clampTimeout(undefined)).toBe(3000);
    expect(clampTimeout(Number.NaN)).toBe(3000);
    expect(clampTimeout(0)).toBe(3000);
    expect(clampTimeout(4500)).toBe(4500);
    expect(clampTimeout(9000)).toBe(5000);
  });
});
