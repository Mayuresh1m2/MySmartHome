import { z } from 'zod';
import { defineTool } from './types.js';

/**
 * Start the robot vacuum cleaning the whole house. A dedicated, no-argument intent (rather than the
 * generic RvcRunMode device tool) so the small model and the keyword router hit it reliably and the
 * reply is a fixed, in-character sentence. It still goes through the DeviceGateway, so hearth-devices
 * core applies policy, risk and audit, and the adapter enforces online + idle.
 */
export const cleanHouse = defineTool({
  name: 'clean_house',
  description:
    'Start the robot vacuum to clean the floors. Use only when asked to run the vacuum or clean the house or floors; not for freeing disk space or tidying files.',
  args: z.object({}),
  risk: 'medium',
  async run(_args, ctx) {
    const all = await ctx.devices.list();
    const vacuum =
      all.find((d) => d.kind === 'robot-vacuum' && d.capabilities.some((c) => c.name === 'RvcRunMode')) ??
      all.find((d) => d.capabilities.some((c) => c.name === 'RvcRunMode'));
    if (!vacuum) return { speech: "I couldn't find a vacuum to start." };

    const r = await ctx.devices.execute(vacuum.id, 'RvcRunMode', { mode: 'cleaning' }, { requestId: ctx.requestId ?? 'unknown' });
    if (!r.ok) {
      // ExecuteResult.error is a short, user-safe reason (e.g. "the water tank is dry", offline, busy).
      return { speech: r.error ? `I can't start the vacuum — ${r.error}.` : "The vacuum won't start right now." };
    }
    return { speech: 'Fine, fine. Calling in the cleaning crew.' };
  },
});
