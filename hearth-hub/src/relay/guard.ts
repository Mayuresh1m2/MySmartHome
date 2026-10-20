export type GuardVerdict = { accept: true } | { accept: false; reason: 'stale' | 'future' | 'duplicate' };

export interface GuardOptions {
  /** Contract: the hub drops commands older than 10 s. */
  staleAfterMs?: number;
  /** How long a requestId is remembered. Anything older is stale anyway, so this only needs to exceed staleAfterMs. */
  rememberMs?: number;
  now?: () => number;
}

/** Applies the contract's staleness and duplicate rules. */
export class CommandGuard {
  private readonly staleAfterMs: number;
  private readonly rememberMs: number;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();

  constructor(opts: GuardOptions = {}) {
    this.staleAfterMs = opts.staleAfterMs ?? 10_000;
    this.rememberMs = opts.rememberMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  check(cmd: { requestId: string; sentAt: number }): GuardVerdict {
    const now = this.now();
    this.prune(now);
    const age = now - cmd.sentAt;
    if (age > this.staleAfterMs) return { accept: false, reason: 'stale' };
    // A timestamp this far ahead means badly skewed clocks; treat it like staleness rather than trust it.
    if (age < -this.staleAfterMs) return { accept: false, reason: 'future' };
    if (this.seen.has(cmd.requestId)) return { accept: false, reason: 'duplicate' };
    this.seen.set(cmd.requestId, now);
    return { accept: true };
  }

  recentIds(): string[] {
    return [...this.seen.keys()];
  }

  private prune(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at > this.rememberMs) this.seen.delete(id);
      else break; // Map keeps insertion order, so the rest are newer.
    }
  }
}
