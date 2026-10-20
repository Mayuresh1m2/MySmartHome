import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { Aedes } from 'aedes';

/**
 * Local stand-in for the hearth-devices Mosquitto bus until Docker/apt access exists (gate G1).
 * Mirrors what mosquitto.conf + passwd + acl will enforce:
 *   - 127.0.0.1 only, password auth, no anonymous clients
 *   - adapter-<id>: publish hearth/local/devices/+/{meta,state,result} and its own adapters/<id>/status; subscribe devices/+/set
 *   - core (hub, registry): subscribe hearth/local/#; publish devices/+/set only
 * Plain TCP like a localhost Mosquitto listener; aedes speaks MQTT 3.1.1.
 */
export interface BusOptions {
  port?: number;
  /** username → password */
  users: Record<string, string>;
  log?: (event: Record<string, unknown>) => void;
}

export interface LocalBus {
  port: number;
  aedes: Aedes;
  close(): Promise<void>;
}

const DEV = 'hearth/local/devices/';

/** MQTT topic-filter matching (+ and #). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export function canPublish(user: string, topic: string): boolean {
  if (user === 'core') return topicMatches(`${DEV}+/set`, topic);
  const m = /^adapter-([a-z0-9-]+)$/.exec(user);
  if (!m) return false;
  return (
    ['meta', 'state', 'result'].some((k) => topicMatches(`${DEV}+/${k}`, topic)) ||
    topic === `hearth/local/adapters/${m[1]}/status`
  );
}

export function canSubscribe(user: string, filter: string): boolean {
  if (user === 'core') return filter === 'hearth/local/#' || filter.startsWith('hearth/local/');
  if (/^adapter-[a-z0-9-]+$/.test(user)) return filter === `${DEV}+/set` || (filter.startsWith(DEV) && filter.endsWith('/set') && !filter.includes('#'));
  return false;
}

export async function startBus(o: BusOptions): Promise<LocalBus> {
  const log = o.log ?? (() => {});
  const userOf = new WeakMap<object, string>();
  const aedes = await Aedes.createBroker({
    authenticate(client, username, password, done) {
      const expected = username ? o.users[username] : undefined;
      const given = password ? Buffer.from(password) : Buffer.alloc(0);
      const ok = expected !== undefined && given.length === Buffer.byteLength(expected) && timingSafeEqual(given, Buffer.from(expected));
      if (!ok) {
        log({ evt: 'auth_denied', clientId: client.id, username });
        return done(Object.assign(new Error('bad credentials'), { returnCode: 4 as const }), false);
      }
      userOf.set(client, username!);
      done(null, true);
    },
    authorizePublish(client, packet, done) {
      if (!client) return done(null); // broker-internal (will messages are published via the client)
      const user = userOf.get(client) ?? '';
      if (!canPublish(user, packet.topic)) {
        log({ evt: 'publish_denied', user, topic: packet.topic });
        return done(new Error('not authorized'));
      }
      done(null);
    },
    authorizeSubscribe(client, sub, done) {
      const user = userOf.get(client) ?? '';
      if (!canSubscribe(user, sub.topic)) {
        log({ evt: 'subscribe_denied', user, topic: sub.topic });
        return done(null, null);
      }
      done(null, sub);
    },
  });
  aedes.on('client', (c) => log({ evt: 'client_connected', clientId: c.id, user: userOf.get(c) }));
  aedes.on('clientDisconnect', (c) => log({ evt: 'client_disconnected', clientId: c.id }));
  aedes.on('publish', (p, c) => {
    if (!p.topic.startsWith('$SYS')) log({ evt: 'publish', topic: p.topic, from: c ? c.id : 'broker', retain: p.retain, bytes: p.payload.length });
  });

  const conns = new Set<import('node:net').Socket>();
  const server: Server = createServer((s) => {
    conns.add(s);
    s.on('close', () => conns.delete(s));
    aedes.handle(s);
  });
  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(o.port ?? 0, '127.0.0.1', () => r());
  });
  const port = (server.address() as { port: number }).port;
  log({ evt: 'bus_listening', port });
  return {
    port,
    aedes,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of conns) s.destroy();
        server.close(() => aedes.close(() => resolve()));
      }),
  };
}
