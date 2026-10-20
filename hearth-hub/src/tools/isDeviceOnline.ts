import { z } from 'zod';
import { defineTool } from './types.js';

export const isDeviceOnline = defineTool({
  name: 'is_device_online',
  description: 'Check whether a known home device (for example "router" or "tv") is reachable on the network.',
  args: z.object({ device: z.string().trim().toLowerCase().min(1).max(40) }),
  risk: 'read',
  async run({ device }, ctx) {
    const d = await ctx.devices.find(device);
    if (!d) return { speech: `I don't know a device called ${device}.` };
    const { online } = await ctx.devices.getState(d.id);
    // Speak the friendly name only; never the address.
    return { speech: `The ${d.name} is ${online ? 'online' : 'not responding'}.` };
  },
});
