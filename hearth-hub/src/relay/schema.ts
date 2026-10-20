import { z } from 'zod';

/** Contract v1, mirrored from contracts/cloud-hub/v1. Contract tests keep the two in step. */
export const CommandV1 = z.strictObject({
  v: z.literal(1),
  requestId: z.guid(),
  text: z.string().min(1).max(500),
  sentAt: z.int().nonnegative(),
});
export type CommandV1 = z.infer<typeof CommandV1>;

export const ReplyStatus = z.enum(['ok', 'refused', 'error']);
export type ReplyStatus = z.infer<typeof ReplyStatus>;

export const ReplyV1 = z.strictObject({
  v: z.literal(1),
  requestId: z.guid(),
  speech: z.string().min(1).max(400),
  status: ReplyStatus,
});
export type ReplyV1 = z.infer<typeof ReplyV1>;

export type ParseResult =
  | { ok: true; command: CommandV1 }
  | { ok: false; reason: 'not_json' | 'wrong_version' | 'invalid'; detail: string; requestId?: string };

/** Parses a raw MQTT payload. Never throws; anything unexpected is a typed rejection. */
export function parseCommand(payload: Buffer | string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    return { ok: false, reason: 'not_json', detail: 'payload is not JSON' };
  }
  const requestId =
    typeof data === 'object' && data !== null && typeof (data as { requestId?: unknown }).requestId === 'string'
      ? ((data as { requestId: string }).requestId.slice(0, 64))
      : undefined;
  if (typeof data === 'object' && data !== null && (data as { v?: unknown }).v !== 1) {
    return { ok: false, reason: 'wrong_version', detail: `v=${JSON.stringify((data as { v?: unknown }).v)}`, requestId };
  }
  const parsed = CommandV1.safeParse(data);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), requestId };
  }
  return { ok: true, command: parsed.data };
}

/** Builds a contract-valid reply, clamping speech so a long tool answer can't break the contract. */
export function makeReply(requestId: string, speech: string, status: ReplyStatus): ReplyV1 {
  const clean = speech.replace(/\s+/g, ' ').trim() || 'Done.';
  const clamped = clean.length > 400 ? `${clean.slice(0, 397)}...` : clean;
  return ReplyV1.parse({ v: 1, requestId, speech: clamped, status });
}
