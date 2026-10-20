/**
 * Standalone devices bus: `pnpm --filter @hearth/local-stack bus`.
 * Users come from BUS_USERS as "name:password,name:password" (tests) or <state>/bus-users.json.
 * Prints {"evt":"bus_listening","port":N} as its first stdout line so callers can discover the port.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startBus } from '../bus.js';
import { stateDir } from '../paths.js';

const users: Record<string, string> = process.env.BUS_USERS
  ? Object.fromEntries(process.env.BUS_USERS.split(',').map((p) => p.split(':') as [string, string]))
  : existsSync(join(stateDir, 'bus-users.json'))
    ? (JSON.parse(readFileSync(join(stateDir, 'bus-users.json'), 'utf8')) as Record<string, string>)
    : {};
const bus = await startBus({
  port: Number(process.env.BUS_PORT ?? 1883),
  users,
  log: (e) => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'local-bus', ...e })),
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void bus.close().then(() => process.exit(0)));
