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
  /** Log utterance text in the skill's logs. Off by default. */
  debugUtterances: z.boolean().default(false),
  /**
   * Hub certificates, each from its own CSR under a stable name (so rotation adds a certificate instead of
   * replacing one). When omitted, csrPath is the single certificate "primary".
   */
  certificates: z
    .array(z.strictObject({ name: z.string().regex(/^[A-Za-z0-9]+$/), csrPath: z.string().min(1), active: z.boolean().default(true) }))
    .min(1)
    .optional(),
});

export interface HubCertificate {
  name: string;
  csrPem: string;
  active: boolean;
}
export type HearthConfig = z.infer<typeof HearthConfig> & { csrPem: string; hubCertificates: HubCertificate[] };

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
  const readCsr = (p: string) => {
    const path = isAbsolute(p) ? p : resolve(projectRoot, p);
    const pem = readFileSync(path, 'utf8');
    if (!pem.includes('BEGIN CERTIFICATE REQUEST')) throw new Error(`${path} is not a PEM CSR`);
    if (pem.includes('PRIVATE KEY')) throw new Error(`${path} contains a private key. Point csrPath at the .csr only.`);
    return pem;
  };
  const certs = parsed.data.certificates ?? [{ name: 'primary', csrPath: parsed.data.csrPath, active: true }];
  const names = new Set(certs.map((c) => c.name));
  if (names.size !== certs.length) throw new Error('certificate names must be unique');
  if (!certs.some((c) => c.active)) throw new Error('at least one certificate must be active, or the hub cannot connect');
  const hubCertificates = certs.map((c) => ({ name: c.name, csrPem: readCsr(c.csrPath), active: c.active }));
  return { ...parsed.data, csrPem: hubCertificates[0]!.csrPem, hubCertificates };
}
