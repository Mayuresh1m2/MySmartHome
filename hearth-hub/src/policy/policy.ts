import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { RISK_ORDER, type Risk } from '../tools/types.js';

const ArgConstraint = z.strictObject({
  enum: z.array(z.string()).optional(),
  maxLength: z.int().positive().optional(),
  pattern: z.string().optional(),
});

const ToolPolicy = z.strictObject({
  enabled: z.boolean(),
  /** Max invocations per rolling minute for this tool. */
  ratePerMinute: z.int().positive().default(10),
  args: z.record(z.string(), ArgConstraint).default({}),
  /** Free-form settings handed to the tool (e.g. folder aliases). */
  settings: z.record(z.string(), z.unknown()).default({}),
});

const PolicyFile = z.strictObject({
  version: z.literal(1),
  /** Highest risk reachable by voice. The spec caps this at medium. */
  voiceRiskCeiling: z.enum(['read', 'low', 'medium']).default('read'),
  /** Max commands per rolling minute across all tools. */
  globalRatePerMinute: z.int().positive().default(30),
  tools: z.record(z.string(), ToolPolicy).default({}),
});
export type PolicyFile = z.infer<typeof PolicyFile>;

export type PolicyDecision =
  | { allow: true; settings: Record<string, unknown> }
  | { allow: false; reason: 'not_in_policy' | 'disabled' | 'risk' | 'arg_constraint' | 'rate_limited'; detail?: string };

/** Deny-by-default policy. A tool that is absent from policy.yaml is refused even if the model picks it. */
export class Policy {
  private readonly calls = new Map<string, number[]>();
  private readonly all: number[] = [];

  constructor(
    readonly file: PolicyFile,
    private readonly now: () => number = Date.now,
  ) {
    // Fail fast on a bad pattern at load time rather than on the first command.
    for (const t of Object.values(file.tools)) for (const c of Object.values(t.args)) if (c.pattern) new RegExp(c.pattern);
  }

  static load(path: string): Policy {
    return Policy.fromObject(parse(readFileSync(path, 'utf8')));
  }

  static fromObject(raw: unknown): Policy {
    const parsed = PolicyFile.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid policy:\n${z.prettifyError(parsed.error)}`);
    return new Policy(parsed.data);
  }

  check(tool: { name: string; risk: Risk }, args: Record<string, unknown>): PolicyDecision {
    const p = this.file.tools[tool.name];
    if (!p) return { allow: false, reason: 'not_in_policy' };
    if (!p.enabled) return { allow: false, reason: 'disabled' };
    // High risk is never reachable by voice in this version, whatever the ceiling says.
    if (tool.risk === 'high' || RISK_ORDER[tool.risk] > RISK_ORDER[this.file.voiceRiskCeiling]) {
      return { allow: false, reason: 'risk', detail: `${tool.risk} > ${this.file.voiceRiskCeiling}` };
    }
    for (const [arg, c] of Object.entries(p.args)) {
      const v = args[arg];
      if (v === undefined) continue;
      const s = String(v);
      if (c.enum && !c.enum.includes(s)) return { allow: false, reason: 'arg_constraint', detail: `${arg} not allowed` };
      if (c.maxLength && s.length > c.maxLength) return { allow: false, reason: 'arg_constraint', detail: `${arg} too long` };
      if (c.pattern && !new RegExp(c.pattern).test(s)) return { allow: false, reason: 'arg_constraint', detail: `${arg} pattern` };
    }
    const now = this.now();
    const recent = (this.calls.get(tool.name) ?? []).filter((t) => now - t < 60_000);
    const allRecent = this.all.filter((t) => now - t < 60_000);
    if (recent.length >= p.ratePerMinute || allRecent.length >= this.file.globalRatePerMinute) {
      this.calls.set(tool.name, recent);
      return { allow: false, reason: 'rate_limited' };
    }
    recent.push(now);
    this.calls.set(tool.name, recent);
    this.all.splice(0, this.all.length, ...allRecent, now);
    return { allow: true, settings: p.settings };
  }

  /** Names of tools that are enabled and within the voice ceiling: what the intent module may offer. */
  enabledTools(): string[] {
    return Object.entries(this.file.tools)
      .filter(([, t]) => t.enabled)
      .map(([n]) => n);
  }
}
