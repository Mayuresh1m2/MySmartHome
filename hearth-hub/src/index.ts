import { loadConfig } from './config.js';
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

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    log.info({ sig }, 'shutting down');
    await relay.stop();
    process.exit(0);
  });
}
