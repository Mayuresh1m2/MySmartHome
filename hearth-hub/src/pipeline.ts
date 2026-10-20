import type { AuditLog } from './audit/audit.js';
import type { IntentEngine } from './intent/types.js';
import type { Logger } from './obs/log.js';
import type { HubMetrics } from './obs/metrics.js';
import type { Policy } from './policy/policy.js';
import { makeReply, type CommandV1, type ReplyStatus, type ReplyV1 } from './relay/schema.js';
import type { StateStore } from './state/store.js';
import type { Tool, ToolContext } from './tools/types.js';

export interface PipelineDeps {
  intent: IntentEngine;
  policy: Policy;
  tools: Map<string, Tool>;
  audit: AuditLog;
  state: StateStore;
  log: Logger;
  metrics: HubMetrics;
  toolContext: Omit<ToolContext, 'settings'>;
}

const SPEECH = {
  unknownTool: "Sorry, I can't do that.",
  badArgs: "Sorry, I didn't understand that request.",
  policy: {
    not_in_policy: "Sorry, I'm not allowed to do that.",
    disabled: 'That is switched off on the hub.',
    risk: "That's not something I can do by voice.",
    arg_constraint: "Sorry, I'm not allowed to do that.",
    rate_limited: "I'm getting a lot of requests. Please try again in a minute.",
  },
  error: 'Sorry, something went wrong on the hub.',
} as const;

export interface PipelineResult {
  reply: ReplyV1;
  tool: string | null;
  args: Record<string, unknown> | null;
  decision: string;
  stages: Record<string, number>;
}

/**
 * intent → policy → tool.run → reply, with an audit line and per-stage timings for every command.
 * Model output is untrusted: the tool must exist, its args must pass the tool's zod schema, then policy.
 * Tool output is spoken, never fed back to the model.
 */
export function createPipeline(d: PipelineDeps) {
  return async function handle(cmd: Pick<CommandV1, 'requestId' | 'text'>, receivedAt = Date.now()): Promise<PipelineResult> {
    const stages: Record<string, number> = {};
    const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        stages[stage] = Math.round(performance.now() - t0);
        d.metrics.stageMs.observe(stages[stage]!, { stage });
      }
    };

    let tool: string | null = null;
    let args: Record<string, unknown> | null = null;
    let decision = 'error';
    let status: ReplyStatus = 'error';
    let speech: string = SPEECH.error;

    try {
      const intent = await timed('intent', () => d.intent.decide(cmd.text));
      if (intent.kind === 'refuse') {
        decision = 'refused:intent';
        status = 'refused';
        speech = intent.speech;
      } else {
        tool = intent.tool;
        const t = d.tools.get(intent.tool);
        const parsed = t?.args.safeParse(intent.args);
        if (!t) {
          decision = 'refused:unknown_tool';
          status = 'refused';
          speech = SPEECH.unknownTool;
        } else if (!parsed?.success) {
          args = intent.args;
          decision = 'refused:bad_args';
          status = 'refused';
          speech = SPEECH.badArgs;
        } else {
          args = parsed.data as Record<string, unknown>;
          const verdict = await timed('policy', async () => d.policy.check(t, args!));
          if (!verdict.allow) {
            decision = `refused:${verdict.reason}`;
            status = 'refused';
            speech = SPEECH.policy[verdict.reason];
          } else {
            const result = await timed('tool', () => t.run(parsed.data, { ...d.toolContext, settings: verdict.settings, requestId: cmd.requestId }));
            decision = 'allowed';
            status = 'ok';
            speech = result.speech;
          }
        }
      }
    } catch (err) {
      decision = 'error';
      status = 'error';
      speech = SPEECH.error;
      d.log.error({ requestId: cmd.requestId, tool, err: (err as Error).message }, 'pipeline error');
    }

    const reply = makeReply(cmd.requestId, speech, status);
    stages.total = Date.now() - receivedAt;
    d.metrics.stageMs.observe(stages.total, { stage: 'total' });
    d.metrics.commands.inc({ outcome: status });
    d.state.record({ requestId: cmd.requestId, tool, status, speech: reply.speech, at: Date.now() });
    d.log.info({ requestId: cmd.requestId, stage: 'done', tool, decision, outcome: status, latencyMs: stages.total, stages }, 'command handled');
    // Spec flow is "... reply, audit": the audit write must not delay the reply. Writes are serialised in AuditLog.
    void d.audit
      .write({ requestId: cmd.requestId, text: cmd.text, tool, args, decision, outcome: status, latencyMs: stages.total, stages })
      .catch((err: Error) => d.log.error({ requestId: cmd.requestId, err: err.message }, 'audit write failed'));
    return { reply, tool, args, decision, stages };
  };
}
