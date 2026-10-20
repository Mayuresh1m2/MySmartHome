import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startHealthServer } from './health/server.js';
import { createLogger } from './obs/log.js';
import { createHubMetrics } from './obs/metrics.js';
import { Relay } from './relay/relay.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const metrics = createHubMetrics();
const app = buildApp(config, log, metrics);

const relay = new Relay(
  {
    host: config.IOT_ENDPOINT,
    port: config.MQTT_PORT,
    protocolVersion: config.MQTT_PROTOCOL_VERSION,
    clientId: config.clientId,
    commandsTopic: config.commandsTopic,
    repliesTopic: config.repliesTopic,
    keyPath: config.keyPath,
    certPath: config.certPath,
    caPath: config.caPath,
  },
  {
    onCommand: async (cmd, receivedAt) => (await app.pipeline(cmd, receivedAt)).reply,
    onDropped: (d) =>
      void app.audit.write({
        requestId: d.requestId ?? null,
        tool: null,
        args: null,
        decision: `dropped:${d.reason}`,
        outcome: null,
        latencyMs: Date.now() - d.receivedAt,
      }),
  },
  log,
  metrics,
);

log.info(
  { hubId: config.HUB_ID, endpoint: config.IOT_ENDPOINT, port: config.MQTT_PORT, mqtt: config.MQTT_PROTOCOL_VERSION, intent: app.intent.name, tools: app.policy.enabledTools() },
  'hearth-hub starting',
);
relay.start();

const health = await startHealthServer({
  port: config.HEALTH_PORT,
  hubId: config.HUB_ID,
  registry: metrics.registry,
  snapshot: () => ({
    mqtt: relay.status,
    modelLoaded: null, // set by the intent module in M3
    lastCommandAt: metrics.lastCommandAt.get() || null,
  }),
});
log.info({ port: health.port }, 'health endpoint on 127.0.0.1');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    log.info({ sig }, 'shutting down');
    await Promise.all([relay.stop(), health.close()]);
    process.exit(0);
  });
}
