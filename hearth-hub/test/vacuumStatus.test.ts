import { describe, expect, it } from 'vitest';
import { vacuumStatus } from '../src/tools/vacuumStatus.js';
import { FakeGateway } from './fakeGateway.js';
import { ctx } from './helpers.js';

describe('vacuum_status', () => {
  it('is read-only and takes no arguments', () => {
    expect(vacuumStatus.risk).toBe('read');
  });

  it('surfaces a fault reason (the headline case: dry water tank)', async () => {
    const devices = new FakeGateway();
    devices.state.vacuum = { online: true, values: { operationalState: 'paused', fault: 'the water tank is dry', battery: 100 } };
    const r = await vacuumStatus.run({}, ctx({ devices }));
    expect(r.speech).toBe("The vacuum isn't running — the water tank is dry.");
  });

  it('reports cleaning in progress', async () => {
    const devices = new FakeGateway();
    devices.state.vacuum = { online: true, values: { operationalState: 'cleaning', fault: null, battery: 80 } };
    const r = await vacuumStatus.run({}, ctx({ devices }));
    expect(r.speech).toBe('The vacuum is cleaning. Battery is at 80 percent.');
  });

  it('reports idle on the dock with battery', async () => {
    const devices = new FakeGateway();
    devices.state.vacuum = { online: true, values: { operationalState: 'sleeping', fault: null, battery: 100 } };
    const r = await vacuumStatus.run({}, ctx({ devices }));
    expect(r.speech).toBe('The vacuum is idle on its dock. Battery is at 100 percent.');
  });

  it('says so when the vacuum is offline', async () => {
    const devices = new FakeGateway();
    devices.state.vacuum.online = false;
    const r = await vacuumStatus.run({}, ctx({ devices }));
    expect(r.speech).toBe('The vacuum is offline right now.');
  });

  it('never starts or stops the vacuum (read only)', async () => {
    const devices = new FakeGateway();
    await vacuumStatus.run({}, ctx({ devices }));
    expect(devices.calls).toEqual([]);
  });
});
