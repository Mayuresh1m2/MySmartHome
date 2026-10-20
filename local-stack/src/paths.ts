import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const stackRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(stackRoot, '..');
export const stateDir = process.env.LOCAL_STACK_STATE ?? join(stackRoot, '.state');
