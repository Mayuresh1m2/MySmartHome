import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { z } from 'zod';
import { matches, type DeviceGateway, type DeviceInfo, type DeviceState, type ExecuteResult } from './gateway.js';

const DevicesFile = z.object({
  devices: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      name: z.string().min(1),
      aliases: z.array(z.string()).default([]),
      host: z.string().min(1),
      port: z.int().min(1).max(65535),
    }),
  ),
});
type Device = z.infer<typeof DevicesFile>['devices'][number];

export type Probe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/** TCP connect check: online if the port accepts a connection within the timeout. */
export const tcpProbe: Probe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const s = new Socket();
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host, () => done(true));
  });

/** Reachability is the only capability a static devices.json entry has. */
const REACHABILITY = { name: 'Reachability', risk: 'read' as const, params: { type: 'object', properties: {}, additionalProperties: false } };

/** First gateway: a static device list with TCP reachability checks. */
export class JsonDeviceGateway implements DeviceGateway {
  readonly name = 'devices.json';
  private readonly devices: Device[];

  constructor(
    source: string | { devices: unknown[] },
    private readonly probe: Probe = tcpProbe,
    private readonly timeoutMs = 1500,
  ) {
    const raw = typeof source === 'string' ? JSON.parse(readFileSync(source, 'utf8')) : source;
    this.devices = DevicesFile.parse(raw).devices;
  }

  private info(d: Device): DeviceInfo {
    return { id: d.id, name: d.name, aliases: d.aliases, capabilities: [REACHABILITY] };
  }

  async list(): Promise<DeviceInfo[]> {
    return this.devices.map((d) => this.info(d));
  }

  async find(q: string): Promise<DeviceInfo | undefined> {
    return (await this.list()).find((d) => matches(d, q));
  }

  async getState(id: string): Promise<DeviceState> {
    const d = this.devices.find((x) => x.id === id);
    const online = d ? await this.probe(d.host, d.port, this.timeoutMs) : false;
    return { online, values: {} };
  }

  async execute(id: string, capability: string): Promise<ExecuteResult> {
    if (capability !== 'Reachability') return { ok: false, error: `${capability} is not supported`, state: {} };
    const s = await this.getState(id);
    return { ok: true, error: null, state: { online: s.online } };
  }
}
