export interface LastResult {
  requestId: string;
  tool: string | null;
  status: 'ok' | 'refused' | 'error';
  speech: string;
  at: number;
}

/** In-memory hub state: the last result, for "what happened". Recent requestIds live in the relay's guard. */
export class StateStore {
  private last?: LastResult;
  lastResult(): LastResult | undefined {
    return this.last;
  }
  record(r: LastResult): void {
    // "What happened" should not overwrite the thing it reports on.
    if (r.tool === 'last_result') return;
    this.last = r;
  }
}
