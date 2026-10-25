import { matches, type DeviceGateway, type DeviceInfo, type DeviceState, type ExecuteResult } from '../src/devices/gateway.js';

/** In-memory gateway with a lamp, a vacuum and a lock, shaped like hearth-devices' fake adapter. */
export class FakeGateway implements DeviceGateway {
  readonly name = 'fake';
  readonly calls: { id: string; capability: string; params: Record<string, unknown>; requestId: string }[] = [];
  /** When set, execute() refuses with this reason — stands in for a device-side fault (e.g. a dry water tank). */
  executeError: string | null = null;
  readonly state: { lamp: DeviceState; vacuum: DeviceState; lock: DeviceState } & Record<string, DeviceState> = {
    lamp: { online: true, values: { on: false } },
    vacuum: { online: true, values: { operationalState: 'docked' } },
    lock: { online: false, values: { locked: true } },
  };
  private readonly devices: DeviceInfo[] = [
    {
      id: 'lamp',
      name: 'desk lamp',
      aliases: ['lamp', 'light'],
      capabilities: [
        { name: 'OnOff', risk: 'low', params: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'], additionalProperties: false } },
        { name: 'LevelControl', risk: 'low', params: { type: 'object', properties: { level: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['level'] } },
      ],
    },
    {
      id: 'vacuum',
      name: 'robot vacuum',
      aliases: ['vacuum', 'hoover'],
      capabilities: [{ name: 'RvcRunMode', risk: 'medium', params: { type: 'object', properties: { mode: { enum: ['idle', 'cleaning'] } }, required: ['mode'] } }],
    },
    { id: 'lock', name: 'front door lock', capabilities: [{ name: 'DoorLock', risk: 'high', params: { type: 'object' } }] },
  ];

  async list() {
    return this.devices;
  }
  async find(q: string) {
    return this.devices.find((d) => matches(d, q));
  }
  async getState(id: string) {
    return this.state[id] ?? { online: false, values: {} };
  }
  async execute(id: string, capability: string, params: Record<string, unknown>, ctx: { requestId: string }): Promise<ExecuteResult> {
    this.calls.push({ id, capability, params, requestId: ctx.requestId });
    const s = this.state[id];
    if (!s?.online) return { ok: false, error: 'device is offline', state: {} };
    if (this.executeError) return { ok: false, error: this.executeError, state: { ...s.values } };
    if (capability === 'OnOff') s.values.on = params.on;
    if (capability === 'RvcRunMode') s.values.operationalState = params.mode === 'cleaning' ? 'running' : 'docked';
    return { ok: true, error: null, state: { ...s.values } };
  }
}
