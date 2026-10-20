import { z } from 'zod';
import { defineTool } from './types.js';

export const lastResult = defineTool({
  name: 'last_result',
  description: 'Repeat what happened with the previous command, for "what happened" or "say that again".',
  args: z.object({}),
  risk: 'read',
  async run(_args, ctx) {
    const last = ctx.state.lastResult();
    if (!last) return { speech: "I haven't handled any commands since I started." };
    const mins = Math.round((Date.now() - last.at) / 60_000);
    const when = mins < 1 ? 'just now' : mins === 1 ? 'a minute ago' : `${mins} minutes ago`;
    const tool = last.tool ? last.tool.replace(/_/g, ' ') : 'no tool';
    return { speech: `${when[0]!.toUpperCase()}${when.slice(1)}, ${tool}: ${last.speech}` };
  },
});
