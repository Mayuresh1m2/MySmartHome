/** Standalone local IoT Core emulator: `pnpm --filter @hearth/local-stack broker`. JSON event log on stdout. */
import { join } from 'node:path';
import { startBroker } from '../broker.js';
import { stateDir } from '../paths.js';

const hubId = process.env.HUB_ID ?? 'laptop';
const port = Number(process.env.BROKER_PORT ?? 8884);
const ca = join(stateDir, 'ca');
const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'local-iot', ...e }));

const broker = await startBroker({
  hubId,
  port,
  caFile: join(ca, 'ca.crt'),
  certFile: join(ca, 'server.crt'),
  keyFile: join(ca, 'server.key'),
  log,
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void broker.close().then(() => process.exit(0)));
