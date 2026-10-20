import { diskSpace } from './diskSpace.js';
import { isDeviceOnline } from './isDeviceOnline.js';
import { lastResult } from './lastResult.js';
import { listFolder } from './listFolder.js';
import { ping } from './ping.js';
import type { Tool } from './types.js';

export const allTools: Tool[] = [ping, diskSpace, listFolder, isDeviceOnline, lastResult] as Tool[];

export function toolMap(tools: Tool[] = allTools): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]));
}
