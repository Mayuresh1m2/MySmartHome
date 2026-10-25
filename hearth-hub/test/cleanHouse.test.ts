import { describe, expect, it } from 'vitest';
import { cleanHouse } from '../src/tools/cleanHouse.js';
import { FakeGateway } from './fakeGateway.js';
import { ctx } from './helpers.js';

describe('clean_house', () => {
  it('starts the vacuum and gives the fixed in-character reply', async () => {
    const devices = new FakeGateway();
    const r = await cleanHouse.run({}, ctx({ devices, requestId: 'req-1' }));
    expect(r.speech).toBe('Fine, fine. Calling in the cleaning crew.');
    // It went through the gateway as an RvcRunMode=cleaning command, carrying the requestId.
    expect(devices.calls).toContainEqual({ id: 'vacuum', capability: 'RvcRunMode', params: { mode: 'cleaning' }, requestId: 'req-1' });
    expect(devices.state.vacuum.values.operationalState).toBe('running');
  });

  it('gives an honest reply when the vacuum is offline, with no secret details', async () => {
    const devices = new FakeGateway();
    devices.state.vacuum.online = false;
    const r = await cleanHouse.run({}, ctx({ devices }));
    expect(r.speech).toBe("I can't start the vacuum — device is offline.");
  });

  it('relays a device-side fault reason (e.g. a dry water tank)', async () => {
    const devices = new FakeGateway();
    devices.executeError = 'the water tank is dry';
    const r = await cleanHouse.run({}, ctx({ devices }));
    expect(r.speech).toBe("I can't start the vacuum — the water tank is dry.");
  });

  it('says so when there is no vacuum (default gateway has none)', async () => {
    const r = await cleanHouse.run({}, ctx()); // JsonDeviceGateway: router/tv, no RvcRunMode
    expect(r.speech).toBe("I couldn't find a vacuum to start.");
  });

  it('is medium risk and takes no arguments', () => {
    expect(cleanHouse.risk).toBe('medium');
  });
});
