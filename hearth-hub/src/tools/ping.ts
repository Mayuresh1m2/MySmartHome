import { z } from 'zod';
import { defineTool } from './types.js';

export const ping = defineTool({
  name: 'ping',
  description: 'Check that the home hub is reachable. Use for "ping", "are you there", "hub status".',
  args: z.object({}),
  risk: 'read',
  run: async () => ({ speech: 'Hub is online.' }),
});
