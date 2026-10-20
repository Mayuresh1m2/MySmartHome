import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { z } from 'zod';
import type { DeviceGateway, DeviceInfo } from './gateway.js';

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

export class JsonDeviceGateway implements DeviceGateway {
  private readonly devices: Device[];
  constructor(
    source: string | { devices: unknown[] },
    private readonly probe: Probe = tcpProbe,
    private readonly timeoutMs = 1500,
  ) {
    const raw = typeof source === 'string' ? JSON.parse(readFileSync(source, 'utf8')) : source;
    this.devices = DevicesFile.parse(raw).devices;
  }
  async list(): Promise<DeviceInfo[]> {
    return this.devices.map(({ id, name }) => ({ id, name }));
  }
  async find(q: string): Promise<DeviceInfo | undefined> {
    const n = q.trim().toLowerCase().replace(/^(the|my)\s+/, '');
    const d = this.devices.find(
      (d) => d.id === n || d.name.toLowerCase() === n || d.aliases.some((a) => a.toLowerCase() === n),
    );
    return d && { id: d.id, name: d.name };
  }
  async isOnline(id: string): Promise<boolean> {
    const d = this.devices.find((d) => d.id === id);
    return d ? this.probe(d.host, d.port, this.timeoutMs) : false;
  }
}
