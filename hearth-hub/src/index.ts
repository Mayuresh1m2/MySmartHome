import { loadConfig } from './config.js';
import { startHealthServer } from './health/server.js';
import { createLogger } from './obs/log.js';
import { createHubMetrics } from './obs/metrics.js';
import { Relay } from './relay/relay.js';
import { makeReply } from './relay/schema.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const metrics = createHubMetrics();

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
    // M1 behaviour: acknowledge every command. Replaced by the pipeline in M2.
    onCommand: async (cmd) => {
      log.info({ requestId: cmd.requestId, stage: 'reply', outcome: 'ok' }, 'command handled');
      metrics.commands.inc({ outcome: 'ok' });
      return makeReply(cmd.requestId, 'Hub is online.', 'ok');
    },
  },
  log,
  metrics,
);

log.info({ hubId: config.HUB_ID, endpoint: config.IOT_ENDPOINT, port: config.MQTT_PORT, mqtt: config.MQTT_PROTOCOL_VERSION }, 'hearth-hub starting');
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
