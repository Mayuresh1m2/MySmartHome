import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';

/** The cloud side when IoT Core is emulated by an external broker (Mosquitto, MQTT 5, mTLS as "hearth-cloud"). */
export interface CloudTransport {
  port: number;
  publish(topic: string, payload: string): Promise<void>;
  onMessage(topic: string, fn: (payload: Buffer) => void): void;
  close(): Promise<void>;
}

export async function connectCloud(o: { host?: string; port: number; caFile: string; certFile: string; keyFile: string; log?: (e: Record<string, unknown>) => void }): Promise<CloudTransport> {
  const log = o.log ?? (() => {});
  const handlers = new Map<string, (p: Buffer) => void>();
  const client = await mqtt.connectAsync({
    protocol: 'mqtts',
    host: o.host ?? 'localhost',
    port: o.port,
    protocolVersion: 5,
    clientId: 'hearth-cloud', // the broker forces it to the certificate CN anyway
    ca: readFileSync(o.caFile),
    cert: readFileSync(o.certFile),
    key: readFileSync(o.keyFile),
    reconnectPeriod: 1000,
  });
  client.on('message', (topic, payload) => {
    handlers.get(topic)?.(payload);
    log({ evt: 'publish', topic, from: 'broker', bytes: payload.length, requestId: requestIdOf(payload) });
  });
  client.on('connect', () => {
    log({ evt: 'cloud_connected' });
    if (handlers.size) void client.subscribeAsync([...handlers.keys()], { qos: 1 });
  });
  log({ evt: 'cloud_connected', port: o.port, protocol: 'mqtt5' });
  return {
    port: o.port,
    async publish(topic, payload) {
      await client.publishAsync(topic, payload, { qos: 1 });
      log({ evt: 'publish', topic, from: 'cloud', bytes: payload.length, requestId: requestIdOf(payload) });
    },
    onMessage(topic, fn) {
      handlers.set(topic, fn);
      void client.subscribeAsync(topic, { qos: 1 });
    },
    close: () => client.endAsync(),
  };
}

function requestIdOf(payload: Buffer | string): string | undefined {
  try {
    const id = (JSON.parse(payload.toString()) as { requestId?: unknown }).requestId;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}
