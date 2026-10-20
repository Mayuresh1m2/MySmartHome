import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

export const HearthConfig = z.strictObject({
  hubId: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  skillId: z.string().startsWith('amzn1.ask.skill.'),
  iotEndpoint: z.string().regex(/^[a-z0-9]+-ats\.iot\.[a-z0-9-]+\.amazonaws\.com$/, 'the ATS data endpoint (aws iot describe-endpoint --endpoint-type iot:Data-ATS)'),
  csrPath: z.string().min(1),
  replyTimeoutMs: z.int().positive().max(5000, 'contract: never above 5000').default(3000),
  budgetEmail: z.email(),
  locale: z.string().default('en-IN'),
});
export type HearthConfig = z.infer<typeof HearthConfig> & { csrPem: string };

/** Loads config/local.json (or HEARTH_CONFIG) relative to the project root and reads the hub's CSR. */
export function loadConfig(projectRoot: string, file = process.env.HEARTH_CONFIG ?? 'config/local.json'): HearthConfig {
  const path = resolve(projectRoot, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${(err as Error).message}\nCopy config/example.json to config/local.json and fill it in.`);
  }
  const parsed = HearthConfig.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  const csrPath = isAbsolute(parsed.data.csrPath) ? parsed.data.csrPath : resolve(projectRoot, parsed.data.csrPath);
  const csrPem = readFileSync(csrPath, 'utf8');
  if (!csrPem.includes('BEGIN CERTIFICATE REQUEST')) throw new Error(`${csrPath} is not a PEM CSR`);
  if (csrPem.includes('PRIVATE KEY')) throw new Error(`${csrPath} contains a private key. Point csrPath at the .csr only.`);
  return { ...parsed.data, csrPem };
}
