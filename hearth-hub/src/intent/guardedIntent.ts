import type { Logger } from '../obs/log.js';
import type { HubMetrics } from '../obs/metrics.js';
import type { ThermalGuard } from '../obs/thermal.js';
import type { Decision, IntentEngine } from './types.js';

/**
 * Uses the model when the thermal guard allows it, and the keyword router otherwise: when the machine is hot,
 * when model calls exceed their rate, or when the model fails or times out. Still at most one model call per
 * command, and every command still gets an answer.
 */
export class GuardedIntent implements IntentEngine {
  readonly name: string;

  constructor(
    private readonly model: IntentEngine & { readonly loaded?: boolean },
    private readonly fallback: IntentEngine,
    private readonly guard: ThermalGuard,
    private readonly log: Logger,
    private readonly metrics?: HubMetrics,
  ) {
    this.name = `${model.name}+${fallback.name}`;
  }

  async decide(text: string): Promise<Decision> {
    // A command sent to a model that is still loading queues behind the load, times out, and can hold up the next
    // command too (Ollama does not stop prompt processing at once on abort; progress/22). Until warm-up completes,
    // answer with the fallback.
    if (this.model.loaded === false) return this.fall(text, 'model_loading', await this.guard.temps());
    const verdict = await this.guard.check();
    if (!verdict.allow) return this.fall(text, verdict.reason, verdict.temps);
    try {
      return await this.model.decide(text);
    } catch (err) {
      return this.fall(text, 'model_error', verdict.temps, (err as Error).message);
    }
  }

  private async fall(text: string, reason: string, temps: { gpuC: number | null; cpuC: number | null }, err?: string): Promise<Decision> {
    this.metrics?.intentFallbacks.inc({ reason });
    this.log.warn({ stage: 'intent', fallback: this.fallback.name, reason, gpuC: temps.gpuC, cpuC: temps.cpuC, err }, 'model skipped; using fallback');
    return this.fallback.decide(text);
  }
}
