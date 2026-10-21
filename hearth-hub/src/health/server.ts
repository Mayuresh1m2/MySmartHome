import { createServer, type Server } from 'node:http';
import type { Registry } from '../obs/metrics.js';

export interface HealthSnapshot {
  mqtt: { state: string; lastConnectedAt: number | null; lastError: string | null; reconnectAttempt: number };
  modelLoaded: boolean | null;
  lastCommandAt: number | null;
  thermal?: { state: string; gpuC: number | null; cpuC: number | null };
}

export interface HealthOptions {
  port: number;
  hubId: string;
  snapshot: () => HealthSnapshot;
  registry: Registry;
}

/**
 * Status endpoint. Bound to 127.0.0.1 only: the hub accepts no other inbound connections.
 *   GET /health   JSON snapshot (always 200 so it can be read while degraded)
 *   GET /ready    200 when connected to the broker, else 503 (for supervisors)
 *   GET /metrics  Prometheus text format
 */
export async function startHealthServer(opts: HealthOptions): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health' || path === '/ready') {
      const s = opts.snapshot();
      const connected = s.mqtt.state === 'connected';
      const body = {
        status: connected ? 'ok' : 'degraded',
        hubId: opts.hubId,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        ...s,
      };
      const code = path === '/ready' && !connected ? 503 : 200;
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    if (path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(opts.registry.render());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return { server, port, close: () => new Promise((r) => server.close(() => r())) };
}
