/** `pnpm try "<text>"`: run intent, policy and the tool without MQTT. Prints the result as JSON. */
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../obs/log.js';
import { createHubMetrics } from '../obs/metrics.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('usage: pnpm try "<text>"');
  process.exit(2);
}
// try needs no broker, so the endpoint may be absent.
process.env.IOT_ENDPOINT ??= 'unused';
const config = loadConfig();
const log = createLogger(process.env.LOG_LEVEL ?? 'warn');
const app = await buildApp(config, log, createHubMetrics());
const r = await app.pipeline({ requestId: randomUUID(), text });
await app.audit.flush();
console.log(JSON.stringify({ text, intent: app.intent.name, tool: r.tool, args: r.args, decision: r.decision, status: r.reply.status, speech: r.reply.speech, stagesMs: r.stages }, null, 2));
