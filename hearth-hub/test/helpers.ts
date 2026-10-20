import { JsonDeviceGateway, type Probe } from '../src/devices/jsonGateway.js';
import { createLogger } from '../src/obs/log.js';
import { StateStore } from '../src/state/store.js';
import type { ToolContext, ToolFs } from '../src/tools/types.js';

export const silentLog = createLogger('silent');

export function fakeFs(files: Record<string, Record<string, number>> = {}, disk = { bsize: 4096, blocks: 1e8, bavail: 4e7 }): ToolFs {
  return {
    readdir: async (p) => {
      const d = files[p];
      if (!d) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return Object.keys(d);
    },
    stat: async (p) => {
      const dir = p.slice(0, p.lastIndexOf('/'));
      const name = p.slice(p.lastIndexOf('/') + 1);
      return { mtimeMs: files[dir]?.[name] ?? 0, isDirectory: () => false };
    },
    statfs: async () => disk,
  };
}

export const devicesFixture = {
  devices: [
    { id: 'router', name: 'router', aliases: ['wifi'], host: '10.0.0.1', port: 80 },
    { id: 'tv', name: 'living room TV', aliases: ['tv', 'telly'], host: '10.0.0.20', port: 8001 },
  ],
};

export function ctx(over: Partial<ToolContext> = {}, probe: Probe = async (h) => h === '10.0.0.1'): ToolContext {
  return {
    log: silentLog,
    state: new StateStore(),
    devices: new JsonDeviceGateway(devicesFixture, probe),
    fs: fakeFs(),
    settings: {},
    ...over,
  };
}
