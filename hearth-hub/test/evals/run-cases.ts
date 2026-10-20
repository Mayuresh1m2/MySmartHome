import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { hubRoot } from '../../src/config.js';

const Case = z.union([
  z.strictObject({ text: z.string(), tool: z.string(), args: z.record(z.string(), z.string()).optional() }),
  z.strictObject({ text: z.string(), refuse: z.literal(true) }),
]);
export const loadCases = (file = join(hubRoot, 'test', 'evals', 'phrases.yaml')) =>
  z.object({ cases: z.array(Case).min(40) }).parse(parse(readFileSync(file, 'utf8'))).cases;

