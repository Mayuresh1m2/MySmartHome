import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { localDevicesV1 } from '@hearth/contracts';
import mqtt, { type MqttClient } from 'mqtt';
import type { Logger } from '../obs/log.js';
import { matches, type DeviceCapability, type DeviceGateway, type DeviceInfo, type DeviceState, type ExecuteResult } from './gateway.js';

const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
const validRegistry = ajv.compile(localDevicesV1.registry);
const validResponse = ajv.compile(localDevicesV1.response);

const REGISTRY = 'hearth/local/core/registry';
const REQUEST = 'hearth/local/core/request/hub';
const RESPONSE = 'hearth/local/core/response/hub';

interface Snapshot {
  updatedAt: number;
  devices: { id: string; name: string; room: string; kind: string; online: boolean; capabilities: DeviceCapability[]; state: Record<string, unknown> }[];
}

export interface MqttGatewayOptions {
  url: string;
  username: string;
  password?: string;
  /** How long to wait for core's answer. Must leave room in the Alexa reply budget. */
  timeoutMs?: number;
  log: Logger;
}

/**
 * DeviceGateway over the hearth-devices bus (local contract v1). The hub never talks to devices or sends
 * `set` itself: it reads core's retained registry snapshot and asks core to run commands, so device policy
 * (risk classes, online/idle) and the device audit log always apply. Core treats these requests as voice.
 */
export class MqttDeviceGateway implements DeviceGateway {
  readonly name = 'hearth-devices';
  private client?: MqttClient;
  private snapshot: Snapshot = { updatedAt: 0, devices: [] };
  private readonly pending = new Map<string, (r: ExecuteResult) => void>();

  constructor(private readonly o: MqttGatewayOptions) {}

  /** Connects and waits (up to waitMs) for the retained registry snapshot, so tools can be generated from it. */
  async start(waitMs = 3000): Promise<void> {
    this.client = await mqtt.connectAsync(this.o.url, {
      clientId: `hearth-hub-gw-${process.pid}`,
      username: this.o.username,
      password: this.o.password,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 2000,
    });
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    this.client.on('error', (err) => this.o.log.warn({ stage: 'devices', err: err.message }, 'devices bus error'));
    await this.client.subscribeAsync([REGISTRY, RESPONSE], { qos: 1 });
    const end = Date.now() + waitMs;
    while (this.snapshot.updatedAt === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    this.o.log.info({ stage: 'devices', devices: this.snapshot.devices.map((d) => d.id) }, 'device registry received');
  }

  async stop(): Promise<void> {
    await this.client?.endAsync();
  }

  private onMessage(topic: string, payload: Buffer): void {
    let doc: unknown;
    try {
      doc = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (topic === REGISTRY) {
      if (validRegistry(doc)) this.snapshot = doc as unknown as Snapshot;
      else this.o.log.warn({ stage: 'devices' }, 'registry snapshot breaks the contract; ignored');
    } else if (topic === RESPONSE && validResponse(doc)) {
      const r = doc as unknown as ExecuteResult & { requestId: string };
      this.pending.get(r.requestId)?.({ ok: r.ok, error: r.error, state: r.state });
    }
  }

  async list(): Promise<DeviceInfo[]> {
    return this.snapshot.devices.map((d) => ({ id: d.id, name: d.name, room: d.room, kind: d.kind, aliases: [], capabilities: d.capabilities }));
  }

  async find(q: string): Promise<DeviceInfo | undefined> {
    return (await this.list()).find((d) => matches(d, q));
  }

  async getState(id: string): Promise<DeviceState> {
    const d = this.snapshot.devices.find((x) => x.id === id);
    return d ? { online: d.online, values: d.state } : { online: false, values: {} };
  }

  async execute(id: string, capability: string, params: Record<string, unknown>, ctx: { requestId: string }): Promise<ExecuteResult> {
    if (!this.client?.connected) return { ok: false, error: 'the device platform is not reachable', state: {} };
    const requestId = ctx.requestId;
    const answer = new Promise<ExecuteResult>((resolve) => this.pending.set(requestId, resolve));
    const timeout = new Promise<ExecuteResult>((resolve) =>
      setTimeout(() => resolve({ ok: false, error: 'the device platform did not answer in time', state: {} }), this.o.timeoutMs ?? 2500),
    );
    try {
      await this.client.publishAsync(REQUEST, JSON.stringify({ v: 1, requestId, deviceId: id, capability, action: 'set', params }), { qos: 1 });
      return await Promise.race([answer, timeout]);
    } finally {
      this.pending.delete(requestId);
    }
  }
}
