import { z } from 'zod';
import { defineTool } from './types.js';

const GiB = 1024 ** 3;

export const diskSpace = defineTool({
  name: 'disk_space',
  description: 'Report how much free disk space the hub machine has left.',
  args: z.object({}),
  risk: 'read',
  async run(_args, ctx) {
    const path = typeof ctx.settings.path === 'string' ? ctx.settings.path : '/';
    const s = await ctx.fs.statfs(path);
    const free = (s.bavail * s.bsize) / GiB;
    const total = (s.blocks * s.bsize) / GiB;
    const pct = total > 0 ? Math.round((free / total) * 100) : 0;
    return { speech: `You have ${Math.round(free)} gigabytes free out of ${Math.round(total)}, about ${pct} percent.` };
  },
});
