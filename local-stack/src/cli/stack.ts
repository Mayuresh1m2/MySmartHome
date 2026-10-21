/** Long-running local cloud: broker + rule + DynamoDB + skill + control endpoint. JSON event log on stdout. */
import { join } from 'node:path';
import { startLocalStack } from '../stack.js';
import { stateDir } from '../paths.js';

const stack = await startLocalStack({
  hubId: process.env.HUB_ID ?? 'laptop',
  stateDir,
  brokerPort: Number(process.env.BROKER_PORT ?? 8884),
  ddbPort: Number(process.env.DDB_PORT ?? 8885),
  controlPort: Number(process.env.CONTROL_PORT ?? 8886),
  replyTimeoutMs: Number(process.env.REPLY_TIMEOUT_MS ?? 3000),
  log: (e) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e })),
  ...(process.env.IOT_PORT
    ? { externalIot: { port: Number(process.env.IOT_PORT), caFile: join(stateDir, 'iot', 'ca.crt'), certFile: join(stateDir, 'iot', 'cloud.crt'), keyFile: join(stateDir, 'iot', 'cloud.key') } }
    : {}),
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void stack.close().then(() => process.exit(0)));
