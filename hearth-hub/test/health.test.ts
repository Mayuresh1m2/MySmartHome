import { afterEach, describe, expect, it } from 'vitest';
import { startHealthServer, type HealthSnapshot } from '../src/health/server.js';
import { createHubMetrics } from '../src/obs/metrics.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

async function start(snapshot: HealthSnapshot) {
  const m = createHubMetrics();
  m.commands.inc({ outcome: 'ok' });
  const h = await startHealthServer({ port: 0, hubId: 'laptop', snapshot: () => snapshot, registry: m.registry });
  close = h.close;
  return { base: `http://127.0.0.1:${h.port}`, server: h.server };
}

const connected: HealthSnapshot = {
  mqtt: { state: 'connected', lastConnectedAt: 1, lastError: null, reconnectAttempt: 0 },
  modelLoaded: null,
  lastCommandAt: null,
};

describe('health server', () => {
  it('binds to 127.0.0.1 only', async () => {
    const { server } = await start(connected);
    const addr = server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
  });

  it('reports ok and ready when connected', async () => {
    const { base } = await start(connected);
    const h = await fetch(`${base}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: 'ok', hubId: 'laptop', mqtt: { state: 'connected' } });
    expect((await fetch(`${base}/ready`)).status).toBe(200);
  });

  it('reports degraded and not ready when disconnected', async () => {
    const { base } = await start({ ...connected, mqtt: { ...connected.mqtt, state: 'reconnecting', lastError: 'boom' } });
    const h = await fetch(`${base}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: 'degraded', mqtt: { lastError: 'boom' } });
    expect((await fetch(`${base}/ready`)).status).toBe(503);
  });

  it('serves Prometheus metrics', async () => {
    const { base } = await start(connected);
    const r = await fetch(`${base}/metrics`);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(await r.text()).toContain('hearth_hub_commands_total{outcome="ok"} 1');
  });

  it('rejects other methods and paths', async () => {
    const { base } = await start(connected);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
