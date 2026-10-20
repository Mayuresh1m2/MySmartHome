import { z } from 'zod';
import type { Logger } from '../obs/log.js';
import type { HubMetrics } from '../obs/metrics.js';
import type { Tool } from '../tools/types.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { Decision, IntentEngine } from './types.js';

/** The slice of ollama-js the intent module uses; injectable so tests never need a model. */
export interface ChatClient {
  chat(req: {
    model: string;
    messages: { role: string; content: string }[];
    tools: OllamaTool[];
    stream: false;
    keep_alive: number | string;
    think?: boolean;
    options?: Record<string, unknown>;
  }): Promise<{ message: { content: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] }; eval_count?: number; prompt_eval_count?: number; total_duration?: number; load_duration?: number }>;
  ps(): Promise<{ models: { name: string; model?: string }[] }>;
  abort?(): void;
}

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const REFUSAL = "Sorry, I can't do that.";

/** Converts hub tools into Ollama tool definitions via z.toJSONSchema. */
export function toOllamaTools(tools: Tool[]): OllamaTool[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.args) as Record<string, unknown>;
    return { type: 'function', function: { name: t.name, description: t.description, parameters } };
  });
}

export interface OllamaIntentOptions {
  client: ChatClient;
  model: string;
  /** Only the tools policy enables; the model never hears about the rest. */
  tools: Tool[];
  log: Logger;
  metrics?: HubMetrics;
  timeoutMs?: number;
}

/**
 * One model call per command, with tool calling. Model output is untrusted: the pipeline validates the tool
 * name and arguments and applies policy. The model's free text is never spoken (a fixed refusal is used).
 */
export class OllamaIntent implements IntentEngine {
  readonly name = 'ollama';
  private readonly tools: OllamaTool[];
  private _loaded = false;

  constructor(private readonly o: OllamaIntentOptions) {
    this.tools = toOllamaTools(o.tools);
  }

  get loaded(): boolean {
    return this._loaded;
  }

  /** Loads the model and pins it in memory (keep_alive -1). Safe to call repeatedly. */
  async warmUp(): Promise<void> {
    const t0 = Date.now();
    await this.call('ping');
    this._loaded = true;
    this.o.metrics?.modelLoaded.set(1);
    this.o.log.info({ stage: 'intent', model: this.o.model, warmUpMs: Date.now() - t0 }, 'model warmed up');
  }

  /** Asks Ollama which models are resident, for /health and metrics. */
  async refreshLoaded(): Promise<boolean> {
    try {
      const { models } = await this.o.client.ps();
      this._loaded = models.some((m) => m.name === this.o.model || m.model === this.o.model || m.name === `${this.o.model}:latest`);
    } catch {
      this._loaded = false;
    }
    this.o.metrics?.modelLoaded.set(this._loaded ? 1 : 0);
    return this._loaded;
  }

  async decide(text: string): Promise<Decision> {
    const t0 = Date.now();
    const res = await this.call(text);
    const calls = res.message.tool_calls ?? [];
    this.o.log.info(
      {
        stage: 'intent',
        model: this.o.model,
        latencyMs: Date.now() - t0,
        toolCalls: calls.map((c) => c.function.name),
        promptTokens: res.prompt_eval_count,
        outputTokens: res.eval_count,
        loadMs: res.load_duration ? Math.round(res.load_duration / 1e6) : undefined,
      },
      'model decided',
    );
    if (calls.length === 0) return { kind: 'refuse', speech: REFUSAL };
    if (calls.length > 1) this.o.log.warn({ stage: 'intent', toolCalls: calls.map((c) => c.function.name) }, 'model returned several tool calls; using the first');
    const first = calls[0]!.function;
    const args = typeof first.arguments === 'object' && first.arguments !== null ? first.arguments : {};
    return { kind: 'tool', tool: String(first.name), args };
  }

  private async call(text: string) {
    const timeoutMs = this.o.timeoutMs ?? 4000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.o.client.abort?.();
        reject(new Error(`model did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.o.client.chat({
          model: this.o.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          tools: this.tools,
          stream: false,
          keep_alive: -1,
          think: false,
          options: { temperature: 0, num_ctx: 2048, num_predict: 96 },
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
