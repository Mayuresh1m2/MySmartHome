import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AuditEntry {
  ts: string;
  requestId: string | null;
  text?: string;
  textLength?: number;
  tool: string | null;
  args: Record<string, unknown> | null;
  /** allowed | refused:<reason> | dropped:<reason> | error */
  decision: string;
  /** Reply status sent, or null when nothing was sent. */
  outcome: 'ok' | 'refused' | 'error' | null;
  latencyMs: number;
  stages?: Record<string, number>;
}

/** Append-only JSONL, one file per UTC day: data/audit/YYYY-MM-DD.jsonl. */
export class AuditLog {
  private ready?: Promise<unknown>;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly includeText: boolean,
  ) {}

  /** Writes are serialised so lines never interleave. Returns when the line is on disk. */
  write(e: Omit<AuditEntry, 'ts' | 'text' | 'textLength'> & { text?: string; ts?: string }): Promise<void> {
    const { text, ...rest } = e;
    const entry: AuditEntry = {
      ...rest,
      ts: e.ts ?? new Date().toISOString(),
      ...(text === undefined ? {} : this.includeText ? { text } : { textLength: text.length }),
    };
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${entry.ts.slice(0, 10)}.jsonl`);
    this.chain = this.chain.then(async () => {
      await this.ready;
      await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    });
    return this.chain;
  }
}
