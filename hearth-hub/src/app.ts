import { readdir, stat, statfs } from 'node:fs/promises';
import { AuditLog } from './audit/audit.js';
import type { HubConfig } from './config.js';
import { JsonDeviceGateway } from './devices/jsonGateway.js';
import { KeywordRouter } from './intent/keywordRouter.js';
import { OllamaIntent } from './intent/ollamaIntent.js';
import { Ollama } from 'ollama';
import type { IntentEngine } from './intent/types.js';
import type { Logger } from './obs/log.js';
import type { HubMetrics } from './obs/metrics.js';
import { createPipeline } from './pipeline.js';
import { Policy } from './policy/policy.js';
import { StateStore } from './state/store.js';
import { generateDeviceTools } from './tools/deviceTools.js';
import { allTools, toolMap } from './tools/index.js';
import type { Tool, ToolFs } from './tools/types.js';
import type { DeviceGateway } from './devices/gateway.js';

export const realFs: ToolFs = {
  readdir: (p) => readdir(p),
  stat: (p) => stat(p),
  statfs: (p) => statfs(p),
};

/**
 * Builds everything after the relay: intent, policy, tools, audit, state. Shared by the service and `pnpm try`.
 * Device tools are generated from the gateway's capabilities and kept only if policy enables them.
 */
export async function buildApp(
  config: HubConfig,
  log: Logger,
  metrics: HubMetrics,
  opts: { intent?: IntentEngine; devices?: DeviceGateway } = {},
) {
  const policy = Policy.load(config.POLICY_FILE);
  const state = new StateStore();
  const audit = new AuditLog(config.AUDIT_DIR, config.AUDIT_TEXT);
  const devices = opts.devices ?? new JsonDeviceGateway(config.DEVICES_FILE);
  const enabled = new Set(policy.enabledTools());
  const deviceTools = (await generateDeviceTools(devices)).filter((t) => enabled.has(t.name));
  const tools = toolMap([...allTools, ...deviceTools] as Tool[]);
  const intent =
    opts.intent ??
    (config.INTENT === 'ollama'
      ? new OllamaIntent({
          client: new Ollama({ host: config.OLLAMA_HOST }),
          model: requireModel(config.OLLAMA_MODEL),
          tools: [...tools.values()].filter((t) => enabled.has(t.name)),
          log,
          metrics,
        })
      : new KeywordRouter());
  const unknown = [...enabled].filter((n) => !tools.has(n));
  if (unknown.length) log.warn({ unknown }, 'policy.yaml enables tools that do not exist');
  const pipeline = createPipeline({ intent, policy, tools, audit, state, log, metrics, toolContext: { log, state, devices, fs: realFs } });
  return { policy, state, audit, devices, tools, intent, pipeline };
}

function requireModel(model: string): string {
  if (!model) throw new Error('INTENT=ollama needs OLLAMA_MODEL in config/hub.env');
  return model;
}
