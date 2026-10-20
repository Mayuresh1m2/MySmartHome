import { readFileSync } from 'node:fs';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { Aedes } from 'aedes';

/**
 * Emulates the AWS IoT Core side that the hub sees: mutual TLS, and the four permissions of the
 * hub policy from hearth-aws/CLAUDE.md:
 *   iot:Connect   client/hearth-<hubId>
 *   iot:Subscribe topicfilter/hearth/<hubId>/commands
 *   iot:Receive   topic/hearth/<hubId>/commands
 *   iot:Publish   topic/hearth/<hubId>/replies
 * Anything else is refused the way IoT Core refuses it: a rejected CONNECT, a failed SUBACK,
 * or a disconnect on an unauthorised PUBLISH.
 * Limitation: aedes speaks MQTT 3.1.1 only, so the hub runs with MQTT_PROTOCOL_VERSION=4 against it.
 */
export interface BrokerOptions {
  hubId: string;
  port?: number;
  host?: string;
  caFile: string;
  certFile: string;
  keyFile: string;
  log?: (event: Record<string, unknown>) => void;
}

export interface LocalBroker {
  port: number;
  aedes: Aedes;
  /** Publish as the "cloud" (what the Lambda does through the IoT Data Plane). */
  publish(topic: string, payload: string): Promise<void>;
  /** Subscribe as the "cloud" (what the IoT rule does). */
  onMessage(topic: string, fn: (payload: Buffer) => void): void;
  connectedClients(): string[];
  /** Drops every client connection without stopping the listener (simulates a network blip). */
  dropClients(): void;
  close(): Promise<void>;
}

export async function startBroker(opts: BrokerOptions): Promise<LocalBroker> {
  const log = opts.log ?? (() => {});
  const clientId = `hearth-${opts.hubId}`;
  const commands = `hearth/${opts.hubId}/commands`;
  const replies = `hearth/${opts.hubId}/replies`;
  const peerCn = new WeakMap<object, string>();

  const aedes = await Aedes.createBroker({
    preConnect(client, _packet, done) {
      const sock = client.conn as TLSSocket;
      const cn = sock.getPeerCertificate?.()?.subject?.CN;
      peerCn.set(client, typeof cn === 'string' ? cn : '');
      done(null, true);
    },
    authenticate(client, _u, _p, done) {
      const cn = peerCn.get(client);
      // IoT Core: the policy on the presented certificate must allow iot:Connect on this client ID.
      if (client.id !== clientId || cn !== clientId) {
        log({ evt: 'connect_denied', clientId: client.id, certCN: cn });
        const err = Object.assign(new Error('not authorized'), { returnCode: 5 as const });
        return done(err, false);
      }
      done(null, true);
    },
    authorizeSubscribe(client, sub, done) {
      if (sub.topic !== commands) {
        log({ evt: 'subscribe_denied', clientId: client.id, topic: sub.topic });
        return done(null, null); // SUBACK failure (0x80), as IoT Core does
      }
      done(null, sub);
    },
    authorizePublish(client, packet, done) {
      if (client && packet.topic !== replies) {
        log({ evt: 'publish_denied', clientId: client.id, topic: packet.topic });
        return done(new Error('not authorized')); // aedes disconnects the client, as IoT Core does
      }
      done(null);
    },
  });

  const clients = new Map<string, { conn: { destroy(): void } }>();
  aedes.on('client', (c) => {
    clients.set(c.id, c);
    log({ evt: 'client_connected', clientId: c.id });
  });
  aedes.on('clientDisconnect', (c) => {
    if (clients.get(c.id) === c) clients.delete(c.id);
    log({ evt: 'client_disconnected', clientId: c.id });
  });
  aedes.on('publish', (packet, client) => {
    if (packet.topic.startsWith('$SYS')) return;
    log({ evt: 'publish', topic: packet.topic, from: client ? client.id : 'cloud', bytes: packet.payload.length, requestId: requestIdOf(packet.payload) });
  });

  const server: Server = createServer(
    {
      key: readFileSync(opts.keyFile),
      cert: readFileSync(opts.certFile),
      ca: readFileSync(opts.caFile),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    (socket) => aedes.handle(socket),
  );
  server.on('tlsClientError', (err) => log({ evt: 'tls_error', error: err.message }));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  log({ evt: 'broker_listening', port, hubId: opts.hubId });

  return {
    port,
    aedes,
    publish: (topic, payload) =>
      new Promise((resolve, reject) =>
        aedes.publish(
          { cmd: 'publish', topic, payload: Buffer.from(payload), qos: 1, retain: false, dup: false },
          (err) => (err ? reject(err) : resolve()),
        ),
      ),
    onMessage(topic, fn) {
      aedes.subscribe(topic, (packet, cb) => {
        fn(Buffer.from(packet.payload));
        cb();
      }, () => {});
    },
    connectedClients: () => [...clients.keys()],
    dropClients() {
      for (const c of clients.values()) c.conn.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients.values()) c.conn.destroy();
        server.close(() => aedes.close(() => resolve()));
      }),
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
