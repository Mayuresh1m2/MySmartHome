import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool } from './types.js';

/**
 * Lists a folder by *alias* (e.g. "downloads"). Policy maps aliases to paths; the model never supplies a path.
 */
export const listFolder = defineTool({
  name: 'list_folder',
  description: 'Say how many items are in one of the allowed folders. The folder is a short name such as "downloads" or "documents".',
  args: z.object({ folder: z.string().trim().toLowerCase().min(1).max(32).regex(/^[a-z0-9 _-]+$/) }),
  risk: 'read',
  async run({ folder }, ctx) {
    const folders = (ctx.settings.folders ?? {}) as Record<string, string>;
    const raw = folders[folder];
    if (!raw) return { speech: `I'm not allowed to look in a folder called ${folder}.` };
    const path = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    const names = (await ctx.fs.readdir(path)).filter((n) => !n.startsWith('.'));
    if (names.length === 0) return { speech: `Your ${folder} folder is empty.` };
    const count = names.length === 1 ? 'one item' : `${names.length} items`;
    // File names leave the house through Amazon, so naming them is opt-in via policy (maxItems > 0).
    const maxItems = typeof ctx.settings.maxItems === 'number' ? ctx.settings.maxItems : 0;
    if (maxItems <= 0) return { speech: `Your ${folder} folder has ${count}.` };
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, t: await ctx.fs.stat(join(path, n)).then((s) => s.mtimeMs, () => 0) })),
    );
    const newest = withTimes
      .sort((a, b) => b.t - a.t)
      .slice(0, maxItems)
      .map((x) => x.n);
    return { speech: `Your ${folder} folder has ${count}. The newest ${newest.length === 1 ? 'is' : 'are'} ${speakList(newest)}.` };
  },
});

function speakList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
