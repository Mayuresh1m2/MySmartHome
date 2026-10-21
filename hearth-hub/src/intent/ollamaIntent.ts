import { z } from 'zod';
import type { Logger } from '../obs/log.js';
import type { HubMetrics } from '../obs/metrics.js';
import type { Tool } from '../tools/types.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { Decision, IntentEngine } from './types.js';

interface ChatPart {
  message: { content: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  load_duration?: number;
}

/**
 * The slice of ollama-js the intent module uses; injectable so tests never need a model.
 * Streaming is used because only a streamed request can really be aborted: a timed-out non-streamed call keeps
 * generating inside Ollama and every following command queues behind it (measured, see progress/18).
 */
export interface ChatClient {
  chat(req: {
    model: string;
    messages: { role: string; content: string }[];
    tools: OllamaTool[];
    stream: true;
    keep_alive: number | string;
    think?: boolean;
    options?: Record<string, unknown>;
  }): Promise<AsyncIterable<ChatPart> & { abort(): void }>;
  ps(): Promise<{ models: { name: string; model?: string }[] }>;
}

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const REFUSAL = "Sorry, I can't do that.";

/**
 * An explicit way out. Small tool-calling models tend to call *some* tool for every request; offering a named
 * "nothing fits" tool lets them refuse by calling it. It is not a hub tool: calling it is a refusal.
 */
export const NO_TOOL: OllamaTool = {
  type: 'function',
  function: {
    name: 'no_matching_tool',
    description:
      'Call this when no other tool clearly does what was asked, including any request to delete, remove, format, unlock, open, start, buy, send, change or control something, to chat, or to tell jokes, news or weather.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

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
  /** Per-command budget once the model is loaded. */
  timeoutMs?: number;
  /** Loading a model from disk takes far longer than a command; warm-up gets its own budget. */
  warmUpTimeoutMs?: number;
  /** Ollama num_gpu: layers on the GPU (0 = CPU only). Undefined lets Ollama decide. */
  numGpu?: number;
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
    this.tools = [...toOllamaTools(o.tools), NO_TOOL];
  }

  get loaded(): boolean {
    return this._loaded;
  }

  /** Loads the model and pins it in memory (keep_alive -1). Safe to call repeatedly. */
  async warmUp(): Promise<void> {
    const t0 = Date.now();
    await this.call('ping', this.o.warmUpTimeoutMs ?? 180_000);
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
        promptMs: res.prompt_eval_duration ? Math.round(res.prompt_eval_duration / 1e6) : undefined,
        outputTokens: res.eval_count,
        genMs: res.eval_duration ? Math.round(res.eval_duration / 1e6) : undefined,
        loadMs: res.load_duration ? Math.round(res.load_duration / 1e6) : undefined,
      },
      'model decided',
    );
    if (calls.length === 0 || calls[0]!.function.name === NO_TOOL.function.name) return { kind: 'refuse', speech: REFUSAL };
    if (calls.length > 1) this.o.log.warn({ stage: 'intent', toolCalls: calls.map((c) => c.function.name) }, 'model returned several tool calls; using the first');
    const first = calls[0]!.function;
    const args = typeof first.arguments === 'object' && first.arguments !== null ? first.arguments : {};
    return { kind: 'tool', tool: String(first.name), args };
  }

  private async call(text: string, timeoutMs = this.o.timeoutMs ?? 4000): Promise<ChatPart> {
    // The budget covers the whole call, including prompt processing before the first streamed part.
    let timedOut = false;
    let stream: (AsyncIterable<ChatPart> & { abort(): void }) | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      stream?.abort(); // frees the model for the next command
    }, timeoutMs);
    const fail = () => new Error(`model did not answer within ${timeoutMs} ms`);
    const out: ChatPart = { message: { content: '', tool_calls: [] } };
    try {
      const pending = this.o.client.chat({
        model: this.o.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        tools: this.tools,
        stream: true,
        keep_alive: -1,
        think: false,
        options: { temperature: 0, num_ctx: 2048, num_predict: 48, ...(this.o.numGpu === undefined ? {} : { num_gpu: this.o.numGpu }) },
      });
      const expired = new Promise<never>((_, reject) => {
        const check = setInterval(() => {
          if (timedOut) {
            clearInterval(check);
            // If the stream arrives after the deadline, abort it at once.
            void pending.then((s) => s.abort(), () => {});
            reject(fail());
          }
        }, 20);
        void pending.finally(() => clearInterval(check));
      });
      stream = await Promise.race([pending, expired]);
      if (timedOut) {
        stream.abort();
        throw fail();
      }
      for await (const part of stream) {
        out.message.content += part.message.content ?? '';
        if (part.message.tool_calls?.length) out.message.tool_calls!.push(...part.message.tool_calls);
        if (part.done) {
          const { eval_count, eval_duration, prompt_eval_count, prompt_eval_duration, load_duration } = part;
          Object.assign(out, { eval_count, eval_duration, prompt_eval_count, prompt_eval_duration, load_duration });
        }
      }
    } catch (err) {
      if (timedOut) throw fail();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw fail();
    return out;
  }
}
