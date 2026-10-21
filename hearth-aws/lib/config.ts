import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const HearthConfig = z.strictObject({
  hubId: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  /** Where Hearth's AWS side lives. New-experience accounts: settings.aws.com → Project → Region. */
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/, 'an AWS Region code, e.g. ap-southeast-2'),
  skillId: z.string().startsWith('amzn1.ask.skill.'),
  iotEndpoint: z.string().regex(/^[a-z0-9]+-ats\.iot\.[a-z0-9-]+\.amazonaws\.com$/, 'the ATS data endpoint (scripts/configure.sh fills it in)'),
  csrPath: z.string().min(1),
  replyTimeoutMs: z.int().positive().max(5000, 'contract: never above 5000').default(3000),
  budgetEmail: z.email(),
  locale: z.string().default('en-IN'),
  /**
   * Kill switch: when the whole account's *actual* monthly cost reaches this many USD (no tag filter: member accounts
   * can't activate cost allocation tags), AWS Budgets automatically attaches a deny-all policy to the skill and rule
   * roles, which stops the cloud side.
   */
  hearthKillSwitchUsd: z.number().positive().max(100).default(1),
  /**
   * Account-wide kill switch: when the whole account's *actual* monthly cost reaches this many USD, the same
   * deny policy is attached automatically (it stops Hearth only, not other services) and an email is sent.
   */
  accountKillSwitchUsd: z.number().positive().max(1000).default(5),
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

/** Every per-person setting comes from these variables (repo-root .env, see .env.example). */
export const ENV_KEYS = {
  hubId: 'HEARTH_HUB_ID',
  region: 'HEARTH_AWS_REGION',
  skillId: 'HEARTH_SKILL_ID',
  iotEndpoint: 'HEARTH_IOT_ENDPOINT',
  csrPath: 'HEARTH_CSR_PATH',
  replyTimeoutMs: 'HEARTH_REPLY_TIMEOUT_MS',
  budgetEmail: 'HEARTH_ALERT_EMAIL',
  locale: 'HEARTH_LOCALE',
  hearthKillSwitchUsd: 'HEARTH_KILL_SWITCH_USD',
  accountKillSwitchUsd: 'HEARTH_ACCOUNT_KILL_SWITCH_USD',
  debugUtterances: 'HEARTH_DEBUG_UTTERANCES',
  certificates: 'HEARTH_CERTIFICATES',
} as const satisfies Record<keyof z.infer<typeof HearthConfig>, string>;

const NUMBERS = new Set(['replyTimeoutMs', 'hearthKillSwitchUsd', 'accountKillSwitchUsd']);

export interface LoadOptions {
  /** Path to the env file (absolute, or relative to the hearth-aws project). Default: HEARTH_ENV_FILE or <repo>/.env. */
  envFile?: string;
  /** Variables that override the file (default: process.env). Tests pass {} for isolation. */
  env?: Record<string, string | undefined>;
}

/**
 * Builds the config from the repo-root .env (copied from .env.example), overridden by real environment variables,
 * and reads the hub's CSR. Errors name the variable to fix.
 */
export function loadConfig(projectRoot: string, opts: LoadOptions = {}): HearthConfig {
  const env = opts.env ?? process.env;
  const repoRoot = resolve(projectRoot, '..');
  const file = opts.envFile ?? env.HEARTH_ENV_FILE ?? join(repoRoot, '.env');
  const path = isAbsolute(file) ? file : resolve(projectRoot, file);
  if (!existsSync(path)) {
    throw new Error(`Cannot find ${path}.\nCopy .env.example to .env at the repo root and fill it in (scripts/configure.sh helps).`);
  }
  const fromFile = parseEnv(readFileSync(path, 'utf8'));
  const value = (k: string) => {
    const v = (env[k] ?? fromFile[k])?.trim();
    return v === undefined || v === '' ? undefined : v;
  };

  const raw: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(ENV_KEYS)) {
    const v = value(key);
    if (v === undefined) continue;
    if (NUMBERS.has(field)) raw[field] = Number(v);
    else if (field === 'debugUtterances') raw[field] = v === 'true';
    else if (field === 'certificates') {
      try {
        raw[field] = JSON.parse(v);
      } catch {
        throw new Error(`${key} must be JSON, e.g. [{"name":"primary","csrPath":"…"}]`);
      }
    } else raw[field] = v;
  }
  raw.hubId ??= 'laptop';
  raw.csrPath ??= join(repoRoot, 'hearth-hub', 'certs', 'hub.csr');

  const parsed = HearthConfig.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = ENV_KEYS[i.path[0] as keyof typeof ENV_KEYS] ?? i.path.join('.');
      const missing = i.code === 'invalid_type' && raw[String(i.path[0])] === undefined;
      return `  ${key}: ${missing ? 'not set' : i.message}`;
    });
    throw new Error(`Invalid settings in ${path}:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  if (!c.iotEndpoint.includes(`.iot.${c.region}.`)) {
    throw new Error(`${ENV_KEYS.iotEndpoint} (${c.iotEndpoint}) is not in ${ENV_KEYS.region}=${c.region}`);
  }

  const readCsr = (p: string) => {
    const csr = isAbsolute(p) ? p : resolve(projectRoot, p);
    const pem = readFileSync(csr, 'utf8');
    if (!pem.includes('BEGIN CERTIFICATE REQUEST')) throw new Error(`${csr} is not a PEM CSR`);
    if (pem.includes('PRIVATE KEY')) throw new Error(`${csr} contains a private key. Point ${ENV_KEYS.csrPath} at the .csr only.`);
    return pem;
  };
  const certs = c.certificates ?? [{ name: 'primary', csrPath: c.csrPath, active: true }];
  const names = new Set(certs.map((x) => x.name));
  if (names.size !== certs.length) throw new Error('certificate names must be unique');
  if (!certs.some((x) => x.active)) throw new Error('at least one certificate must be active, or the hub cannot connect');
  const hubCertificates = certs.map((x) => ({ name: x.name, csrPem: readCsr(x.csrPath), active: x.active }));
  return { ...c, csrPem: hubCertificates[0]!.csrPem, hubCertificates };
}

/** Applies numeric overrides (e.g. from CDK context) with the same validation as the env file. */
export function applyOverrides(config: HearthConfig, overrides: Partial<Pick<HearthConfig, 'hearthKillSwitchUsd' | 'accountKillSwitchUsd'>>): HearthConfig {
  const limits = HearthConfig.pick({ hearthKillSwitchUsd: true, accountKillSwitchUsd: true }).partial().safeParse(overrides);
  if (!limits.success) throw new Error(`Invalid override:\n${z.prettifyError(limits.error)}`);
  return { ...config, ...limits.data };
}
