import mqtt, { type MqttClient } from 'mqtt';
import {
  SET_FILTER,
  adapterStatusTopic,
  ajv,
  deviceTopic,
  isValid,
  statePayload,
  validate,
  type DeviceMeta,
  type Result,
  type SetCommand,
} from './contract.js';

/** Throw from execute() with a short, user-safe reason; it is published in result.error. */
export class CommandError extends Error {}

export interface Adapter {
  /** Lowercase id; the MQTT username is adapter-<id>. */
  readonly adapterId: string;
  readonly pollIntervalMs?: number;
  /** High-risk capabilities are refused unless the adapter opts in (defence in depth). */
  readonly allowHighRisk?: boolean;
  discover(): Promise<DeviceMeta[]>;
  /** Capability values for one device. Throw to mark it offline. */
  readState(deviceId: string): Promise<Record<string, unknown>>;
  /** Carry out a validated command. Return new state values, or undefined to re-read. */
  execute(deviceId: string, cmd: SetCommand): Promise<Record<string, unknown> | undefined>;
}

export interface BusSettings {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

type Log = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
const jsonLog: Log = (level, msg, fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'hearth-adapter', msg, ...fields }));

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, j) => setTimeout(() => j(Object.assign(new Error(`${what} timed out`), { timeout: true })), ms))]);

/** Runs an Adapter on the bus: status + last will, meta, state polling, set → result + state. */
export class AdapterRunner {
  readonly devices = new Map<string, DeviceMeta>();
  private client?: MqttClient;
  private poll?: NodeJS.Timeout;

  constructor(
    private readonly adapter: Adapter,
    private readonly bus: BusSettings = {},
    private readonly log: Log = jsonLog,
    private readonly commandTimeoutMs = 10_000,
  ) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(adapter.adapterId)) throw new Error(`bad adapterId ${adapter.adapterId}`);
  }

  get statusTopic() {
    return adapterStatusTopic(this.adapter.adapterId);
  }

  async start(): Promise<void> {
    const id = `adapter-${this.adapter.adapterId}`;
    this.client = await mqtt.connectAsync(`mqtt://${this.bus.host ?? '127.0.0.1'}:${this.bus.port ?? 1883}`, {
      clientId: id,
      username: this.bus.username ?? id,
      password: this.bus.password,
      protocolVersion: 4,
      keepalive: 30,
      will: { topic: this.statusTopic, payload: Buffer.from('offline'), qos: 1, retain: true },
    });
    // Subscribe before announcing: once meta/state say "online", core may send a set immediately, and a set
    // that reaches the broker before this subscription exists is lost (seen on real Mosquitto).
    this.client.on('message', (topic, payload) => {
      const parts = topic.split('/');
      if (parts.length === 5 && parts[4] === 'set' && this.devices.has(parts[3]!)) {
        this.handleSet(parts[3]!, payload).catch((err: Error) => this.log('error', 'set handling failed', { err: err.message }));
      }
    });
    await this.client.subscribeAsync(SET_FILTER, { qos: 1 });
    await this.client.publishAsync(this.statusTopic, 'online', { qos: 1, retain: true });
    // mqtt.js reconnects and resubscribes on its own, but the broker published our last will ("offline") when
    // the link dropped, so announce "online" again and refresh state after every reconnect.
    this.client.on('connect', () => {
      this.log('info', 'reconnected', { adapter: this.adapter.adapterId });
      this.client!.publishAsync(this.statusTopic, 'online', { qos: 1, retain: true })
        .then(() => Promise.all([...this.devices.keys()].map((d) => this.publishState(d))))
        .catch((err: Error) => this.log('warn', 're-announce failed', { err: err.message }));
    });
    for (const meta of await this.adapter.discover()) {
      if (meta.adapter !== this.adapter.adapterId) throw new Error(`device ${meta.id} declares adapter ${meta.adapter}`);
      validate('meta', meta);
      this.devices.set(meta.id, meta);
      await this.client.publishAsync(deviceTopic(meta.id, 'meta'), JSON.stringify(meta), { qos: 1, retain: true });
      await this.publishState(meta.id);
    }
    this.poll = setInterval(() => {
      for (const d of this.devices.keys()) {
        // Background work must never surface as an unhandled rejection (it would kill the adapter process).
        this.publishState(d).catch((err: Error) => this.log('warn', 'state publish failed', { deviceId: d, err: err.message }));
      }
    }, this.adapter.pollIntervalMs ?? 30_000);
    this.log('info', 'adapter online', { adapter: this.adapter.adapterId, devices: [...this.devices.keys()] });
  }

  /** Graceful stop: publishes the same "offline" the last will would. */
  async stop(): Promise<void> {
    clearInterval(this.poll);
    if (!this.client) return;
    await this.client.publishAsync(this.statusTopic, 'offline', { qos: 1, retain: true });
    await this.client.endAsync();
    this.log('info', 'adapter offline', { adapter: this.adapter.adapterId });
  }

  async publishState(deviceId: string, values?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let online = true;
    if (values === undefined) {
      try {
        values = await withTimeout(this.adapter.readState(deviceId), this.commandTimeoutMs, 'readState');
      } catch (err) {
        this.log('warn', 'state read failed', { deviceId, err: (err as Error).message });
        values = {};
        online = false;
      }
    }
    const doc = statePayload(online, values);
    validate('state', doc);
    await this.client!.publishAsync(deviceTopic(deviceId, 'state'), JSON.stringify(doc), { qos: 1, retain: true });
    return doc;
  }

  async handleSet(deviceId: string, payload: Buffer): Promise<Result | undefined> {
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString());
    } catch {
      this.log('warn', 'set dropped: not JSON', { deviceId });
      return undefined;
    }
    const requestId = typeof (raw as { requestId?: unknown })?.requestId === 'string' ? (raw as { requestId: string }).requestId : undefined;
    if (!isValid('set', raw)) {
      if (!requestId) {
        this.log('warn', 'set dropped: invalid and no requestId', { deviceId });
        return undefined;
      }
      return this.result(deviceId, requestId, false, 'invalid command');
    }
    const cmd = raw as SetCommand;
    const cap = this.devices.get(deviceId)!.capabilities.find((c) => c.name === cmd.capability);
    if (!cap) return this.result(deviceId, cmd.requestId, false, `unknown capability ${cmd.capability}`);
    if (cap.risk === 'high' && !this.adapter.allowHighRisk) return this.result(deviceId, cmd.requestId, false, 'high-risk capability is disabled');
    const check = ajv.compile(Object.keys(cap.params).length ? cap.params : { type: 'object' });
    if (!check(cmd.params)) return this.result(deviceId, cmd.requestId, false, `invalid params: ${ajv.errorsText(check.errors)}`);
    let values: Record<string, unknown> | undefined;
    try {
      values = await withTimeout(this.adapter.execute(deviceId, cmd), this.commandTimeoutMs, 'execute');
    } catch (err) {
      if (err instanceof CommandError) return this.result(deviceId, cmd.requestId, false, err.message);
      if ((err as { timeout?: boolean }).timeout) return this.result(deviceId, cmd.requestId, false, 'device did not respond in time');
      this.log('error', 'execute failed', { deviceId, requestId: cmd.requestId, err: (err as Error).message });
      return this.result(deviceId, cmd.requestId, false, 'adapter error');
    }
    const state = await this.publishState(deviceId, values);
    return this.result(deviceId, cmd.requestId, true, null, state);
  }

  private async result(deviceId: string, requestId: string, ok: boolean, error: string | null, state?: Record<string, unknown>): Promise<Result> {
    const doc: Result = { v: 1, requestId, ok, error, state: state ?? (await this.publishState(deviceId)) };
    validate('result', doc);
    await this.client!.publishAsync(deviceTopic(deviceId, 'result'), JSON.stringify(doc), { qos: 1 });
    this.log('info', 'command handled', { deviceId, requestId, ok, error });
    return doc;
  }
}
