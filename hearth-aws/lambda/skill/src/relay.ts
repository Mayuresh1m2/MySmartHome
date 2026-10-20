import { randomUUID } from 'node:crypto';
import type { Outcome } from './obs.js';
import type { CommandPublisher, ReplyStore, ReplyV1 } from './ports.js';

export interface RelayConfig {
  hubId: string;
  /** Contract: default 3000, never above 5000. */
  replyTimeoutMs: number;
  pollIntervalMs?: number;
}

export interface RelayResult {
  requestId: string;
  outcome: Outcome;
  latencyMs: number;
  reply?: ReplyV1;
}

export const MAX_REPLY_TIMEOUT_MS = 5000;

export function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return 3000;
  return Math.min(Math.round(ms), MAX_REPLY_TIMEOUT_MS);
}

function asReply(item: Record<string, unknown>, requestId: string): ReplyV1 | undefined {
  const { v, speech, status } = item;
  if (v !== 1 || item.requestId !== requestId) return undefined;
  if (typeof speech !== 'string' || speech.length === 0 || speech.length > 400) return undefined;
  if (status !== 'ok' && status !== 'refused' && status !== 'error') return undefined;
  return { v: 1, requestId, speech, status };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Publishes the command, then polls the replies table until a reply arrives or the timeout passes. */
export async function relayCommand(
  text: string,
  cfg: RelayConfig,
  publisher: CommandPublisher,
  replies: ReplyStore,
  now: () => number = Date.now,
): Promise<RelayResult> {
  const requestId = randomUUID();
  const start = now();
  const timeout = clampTimeout(cfg.replyTimeoutMs);
  const interval = cfg.pollIntervalMs ?? 150;
  try {
    await publisher.publish(`hearth/${cfg.hubId}/commands`, { v: 1, requestId, text, sentAt: start });
  } catch {
    return { requestId, outcome: 'publish_failed', latencyMs: now() - start };
  }
  while (now() - start < timeout) {
    await sleep(Math.min(interval, Math.max(0, timeout - (now() - start))));
    const item = await replies.get(requestId).catch(() => undefined);
    if (item) {
      const reply = asReply(item, requestId);
      return reply
        ? { requestId, outcome: reply.status, latencyMs: now() - start, reply }
        : { requestId, outcome: 'bad_reply', latencyMs: now() - start };
    }
  }
  return { requestId, outcome: 'timeout', latencyMs: now() - start };
}
