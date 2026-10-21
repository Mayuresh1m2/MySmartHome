import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const hubRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const Env = z.object({
  IOT_ENDPOINT: z.string().min(1),
  HUB_ID: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens').default('laptop'),
  AWS_REGION: z.string().default('eu-west-1'),
  MQTT_PORT: z.coerce.number().int().positive().default(8883),
  /** 5 for AWS IoT Core. local-stack's aedes broker only speaks 3.1.1, so it sets 4. */
  MQTT_PROTOCOL_VERSION: z.coerce.number().pipe(z.union([z.literal(4), z.literal(5)])).default(5),
  CERTS_DIR: z.string().default(join(hubRoot, 'certs')),
  /** CA that signs the broker's server cert. Amazon Root CA 1 in production, the local CA in local-stack. */
  CA_FILE: z.string().optional(),
  /** Overrides certs/hub.crt. local-stack signs the same CSR with its own CA and points here. */
  CERT_FILE: z.string().optional(),
  OLLAMA_HOST: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default(''),
  /** Layers to offload to the GPU (Ollama num_gpu). Unset: Ollama decides. 0: CPU only. */
  OLLAMA_NUM_GPU: z.coerce.number().int().nonnegative().optional(),
  INTENT: z.enum(['keyword', 'ollama']).default('keyword'),
  /** Per-command model budget. Must stay below the Lambda's REPLY_TIMEOUT_MS minus publish time. */
  INTENT_TIMEOUT_MS: z.coerce.number().int().positive().max(4800).default(4000),
  /** Thermal guard (progress/21): above these the hub stops using the model and falls back to the keyword router. */
  THERMAL_GPU_MAX_C: z.coerce.number().positive().default(95),
  THERMAL_CPU_MAX_C: z.coerce.number().positive().default(90),
  MODEL_CALLS_PER_MINUTE: z.coerce.number().int().positive().default(12),
  HEALTH_PORT: z.coerce.number().int().nonnegative().default(8787),
  AUDIT_DIR: z.string().default(join(hubRoot, 'data', 'audit')),
  AUDIT_TEXT: z.stringbool().default(true),
  /** Audit day files older than this are deleted at startup and daily. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  POLICY_FILE: z.string().default(join(hubRoot, 'config', 'policy.yaml')),
  DEVICES_FILE: z.string().default(join(hubRoot, 'config', 'devices.json')),
  /** json: static config/devices.json. mqtt: the hearth-devices platform through its core (local contract v1). */
  DEVICES: z.enum(['json', 'mqtt']).default('json'),
  DEVICES_BUS_URL: z.string().default('mqtt://127.0.0.1:1883'),
  DEVICES_BUS_USER: z.string().default('hub'),
  DEVICES_BUS_PASSWORD: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type HubConfig = z.infer<typeof Env> & {
  clientId: string;
  commandsTopic: string;
  repliesTopic: string;
  keyPath: string;
  certPath: string;
  caPath: string;
};

/**
 * Loads config/hub.env (or HUB_ENV_FILE) into process.env without overriding
 * variables that are already set, then validates.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const file = env.HUB_ENV_FILE ?? join(hubRoot, 'config', 'hub.env');
  if (env === process.env && existsSync(file)) process.loadEnvFile(file);
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid hub config:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  return {
    ...c,
    clientId: `hearth-${c.HUB_ID}`,
    commandsTopic: `hearth/${c.HUB_ID}/commands`,
    repliesTopic: `hearth/${c.HUB_ID}/replies`,
    keyPath: join(c.CERTS_DIR, 'hub.key'),
    certPath: c.CERT_FILE ?? join(c.CERTS_DIR, 'hub.crt'),
    caPath: c.CA_FILE ?? join(c.CERTS_DIR, 'AmazonRootCA1.pem'),
  };
}
