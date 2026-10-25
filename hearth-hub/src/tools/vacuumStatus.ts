import { z } from 'zod';
import { defineTool } from './types.js';

/**
 * Read-only: say what the robot vacuum is doing and surface any fault (a dry water tank, a full bin,
 * stuck, low battery). The vacuum often accepts a "start" and only discovers a problem a few seconds
 * later, after the spoken reply has gone out — so this lets the owner ask and hear the real reason.
 * It only reads the DeviceGateway state; it never starts or stops the vacuum.
 */
export const vacuumStatus = defineTool({
  name: 'vacuum_status',
  description:
    'Say what the robot vacuum is doing right now and whether something is wrong (for example a dry water tank, a full bin, or it is stuck). Use when asked how the vacuum is, whether it is running or finished or stuck, or why it stopped. Read only; it never starts or stops the vacuum.',
  args: z.object({}),
  risk: 'read',
  async run(_args, ctx) {
    const all = await ctx.devices.list();
    const vacuum =
      all.find((d) => d.kind === 'robot-vacuum' && d.capabilities.some((c) => c.name === 'RvcRunMode')) ??
      all.find((d) => d.capabilities.some((c) => c.name === 'RvcRunMode'));
    if (!vacuum) return { speech: "I couldn't find a vacuum." };

    const st = await ctx.devices.getState(vacuum.id);
    if (!st.online) return { speech: 'The vacuum is offline right now.' };

    const v = st.values;
    const state = typeof v.operationalState === 'string' ? v.operationalState : 'idle';
    const fault = typeof v.fault === 'string' && v.fault ? v.fault : null;
    const battery = typeof v.battery === 'number' ? v.battery : null;

    if (fault) return { speech: `The vacuum isn't running — ${fault}.` };

    let speech: string;
    if (/clean|sweep|mop/.test(state)) speech = 'The vacuum is cleaning.';
    else if (state === 'returning') speech = 'The vacuum is heading back to its dock.';
    else if (state === 'paused') speech = 'The vacuum is paused.';
    else if (/charg|dock|sleep|standby|idle/.test(state)) speech = 'The vacuum is idle on its dock.';
    else speech = `The vacuum is ${state}.`;
    if (battery !== null) speech += ` Battery is at ${battery} percent.`;
    return { speech };
  },
});
