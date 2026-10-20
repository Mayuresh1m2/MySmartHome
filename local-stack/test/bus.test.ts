import mqtt from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canPublish, canSubscribe, startBus, topicMatches, type LocalBus } from '../src/bus.js';

describe('bus ACL rules', () => {
  it('topic matching', () => {
    expect(topicMatches('a/+/c', 'a/b/c')).toBe(true);
    expect(topicMatches('a/#', 'a/b/c')).toBe(true);
    expect(topicMatches('a/+', 'a/b/c')).toBe(false);
  });
  it('adapters publish device meta/state/result and only their own status', () => {
    expect(canPublish('adapter-fake', 'hearth/local/devices/lamp/state')).toBe(true);
    expect(canPublish('adapter-fake', 'hearth/local/adapters/fake/status')).toBe(true);
    expect(canPublish('adapter-fake', 'hearth/local/adapters/tv/status')).toBe(false);
    expect(canPublish('adapter-fake', 'hearth/local/devices/lamp/set')).toBe(false);
  });
  it('core sends set only and may read everything', () => {
    expect(canPublish('core', 'hearth/local/devices/lamp/set')).toBe(true);
    expect(canPublish('core', 'hearth/local/devices/lamp/state')).toBe(false);
    expect(canSubscribe('core', 'hearth/local/#')).toBe(true);
    expect(canSubscribe('adapter-fake', 'hearth/local/#')).toBe(false);
    expect(canSubscribe('adapter-fake', 'hearth/local/devices/+/set')).toBe(true);
  });
});

describe('bus server', () => {
  let bus: LocalBus;
  beforeAll(async () => {
    bus = await startBus({ users: { core: 'c0re', 'adapter-fake': 'f4ke' } });
  });
  afterAll(() => bus.close());

  const conn = (username?: string, password?: string) =>
    mqtt.connect(`mqtt://127.0.0.1:${bus.port}`, { username, password, reconnectPeriod: 0, protocolVersion: 4 });
  const outcome = (c: mqtt.MqttClient) =>
    new Promise<string>((r) => {
      c.once('connect', () => r('connected'));
      c.once('error', (e) => r(e.message));
    });

  it('rejects anonymous and wrong passwords', async () => {
    for (const c of [conn(), conn('core', 'nope'), conn('stranger', 'x')]) {
      expect(await outcome(c)).toMatch(/Bad username or password/i);
      c.end(true);
    }
  });

  it('delivers last will when an adapter drops', async () => {
    const core = conn('core', 'c0re');
    await outcome(core);
    await core.subscribeAsync('hearth/local/adapters/+/status');
    const got = new Promise<string>((r) => core.on('message', (_t, p) => p.toString() === 'offline' && r('offline')));
    const adapter = mqtt.connect(`mqtt://127.0.0.1:${bus.port}`, {
      username: 'adapter-fake', password: 'f4ke', reconnectPeriod: 0,
      will: { topic: 'hearth/local/adapters/fake/status', payload: Buffer.from('offline'), qos: 1, retain: true },
    });
    await outcome(adapter);
    adapter.stream.destroy(); // ungraceful: broker must publish the will
    expect(await got).toBe('offline');
    core.end(true);
  });
});
