import { readdir, stat, statfs } from 'node:fs/promises';
import { AuditLog } from './audit/audit.js';
import type { HubConfig } from './config.js';
import { JsonDeviceGateway } from './devices/jsonGateway.js';
import { KeywordRouter } from './intent/keywordRouter.js';
import type { IntentEngine } from './intent/types.js';
import type { Logger } from './obs/log.js';
import type { HubMetrics } from './obs/metrics.js';
import { createPipeline } from './pipeline.js';
import { Policy } from './policy/policy.js';
import { StateStore } from './state/store.js';
import { toolMap } from './tools/index.js';
import type { ToolFs } from './tools/types.js';

export const realFs: ToolFs = {
  readdir: (p) => readdir(p),
  stat: (p) => stat(p),
  statfs: (p) => statfs(p),
};

/** Builds everything after the relay: intent, policy, tools, audit, state. Shared by the service and `pnpm try`. */
export function buildApp(config: HubConfig, log: Logger, metrics: HubMetrics, intent: IntentEngine = new KeywordRouter()) {
  const policy = Policy.load(config.POLICY_FILE);
  const state = new StateStore();
  const audit = new AuditLog(config.AUDIT_DIR, config.AUDIT_TEXT);
  const devices = new JsonDeviceGateway(config.DEVICES_FILE);
  const tools = toolMap();
  const unknown = policy.enabledTools().filter((n) => !tools.has(n));
  if (unknown.length) log.warn({ unknown }, 'policy.yaml enables tools that do not exist');
  const pipeline = createPipeline({ intent, policy, tools, audit, state, log, metrics, toolContext: { log, state, devices, fs: realFs } });
  return { policy, state, audit, devices, tools, intent, pipeline };
}
