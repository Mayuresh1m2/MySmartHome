import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { diskSpace } from '../src/tools/diskSpace.js';
import { allTools } from '../src/tools/index.js';
import { isDeviceOnline } from '../src/tools/isDeviceOnline.js';
import { lastResult } from '../src/tools/lastResult.js';
import { listFolder } from '../src/tools/listFolder.js';
import { ping } from '../src/tools/ping.js';
import { StateStore } from '../src/state/store.js';
import { ctx, fakeFs } from './helpers.js';

describe('tool registry', () => {
  it('every tool has a unique snake_case name, a description, a risk and an object schema', () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of allTools) {
      expect(t.name).toMatch(/^[a-z][a-z_]*$/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(['read', 'low', 'medium', 'high']).toContain(t.risk);
      // M3 hands these to Ollama as tool parameters, so each must export as an object JSON Schema.
      expect(z.toJSONSchema(t.args)).toMatchObject({ type: 'object' });
    }
  });
  it('no tool in this version is above read risk', () => {
    expect(allTools.every((t) => t.risk === 'read')).toBe(true);
  });
});

describe('ping', () => {
  it('says the hub is online', async () => {
    expect((await ping.run({}, ctx())).speech).toBe('Hub is online.');
  });
});

describe('disk_space', () => {
  it('speaks free and total in gigabytes with a percentage', async () => {
    const GiB = 1024 ** 3;
    const c = ctx({ fs: fakeFs({}, { bsize: 1024, blocks: (500 * GiB) / 1024, bavail: (125 * GiB) / 1024 }), settings: { path: '/' } });
    expect((await diskSpace.run({}, c)).speech).toBe('You have 125 gigabytes free out of 500, about 25 percent.');
  });
});

describe('list_folder', () => {
  const files = { '/data/dl': { 'a.pdf': 1, 'b.zip': 3, 'c.txt': 2, '.hidden': 9 } };
  const settings = { folders: { downloads: '/data/dl', empty: '/data/empty' } };

  it('speaks only the count by default, ignoring hidden files', async () => {
    const r = await listFolder.run({ folder: 'downloads' }, ctx({ fs: fakeFs(files), settings }));
    expect(r.speech).toBe('Your downloads folder has 3 items.');
  });
  it('names the newest items when policy opts in', async () => {
    const r = await listFolder.run({ folder: 'downloads' }, ctx({ fs: fakeFs(files), settings: { ...settings, maxItems: 2 } }));
    expect(r.speech).toBe('Your downloads folder has 3 items. The newest are b.zip and c.txt.');
  });
  it('refuses folders that are not aliased in policy, without touching the filesystem', async () => {
    const r = await listFolder.run({ folder: 'etc' }, ctx({ fs: fakeFs({}), settings }));
    expect(r.speech).toMatch(/not allowed/);
  });
  it('handles an empty folder', async () => {
    const r = await listFolder.run({ folder: 'empty' }, ctx({ fs: fakeFs({ '/data/empty': {} }), settings }));
    expect(r.speech).toBe('Your empty folder is empty.');
  });
  it('rejects path-like folder arguments at the schema', () => {
    for (const bad of ['../etc', '/etc', 'a/b', '~', '']) expect(listFolder.args.safeParse({ folder: bad }).success, bad).toBe(false);
  });
});

describe('is_device_online', () => {
  it('reports online and offline by friendly name, never the address', async () => {
    expect((await isDeviceOnline.run({ device: 'wifi' }, ctx())).speech).toBe('The router is online.');
    const r = await isDeviceOnline.run({ device: 'the telly' }, ctx());
    expect(r.speech).toBe('The living room TV is not responding.');
    expect(r.speech).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
  it('says so for unknown devices', async () => {
    expect((await isDeviceOnline.run({ device: 'fridge' }, ctx())).speech).toBe("I don't know a device called fridge.");
  });
});

describe('last_result', () => {
  it('reports when nothing has happened', async () => {
    expect((await lastResult.run({}, ctx())).speech).toMatch(/haven't handled/);
  });
  it('repeats the previous result and is not itself recorded', async () => {
    const state = new StateStore();
    state.record({ requestId: 'a', tool: 'disk_space', status: 'ok', speech: 'You have 5 gigabytes free.', at: Date.now() });
    state.record({ requestId: 'b', tool: 'last_result', status: 'ok', speech: 'ignored', at: Date.now() });
    expect((await lastResult.run({}, ctx({ state }))).speech).toBe('Just now, disk space: You have 5 gigabytes free.');
  });
});
