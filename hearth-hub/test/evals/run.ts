/**
 * `pnpm eval [--intent keyword|ollama] [--model <name>] [--repeat N]`
 * Runs test/evals/phrases.yaml through the intent module and the pipeline's pre-execution checks
 * (tool exists, args schema, policy), then prints accuracy, refusal coverage and intent latency p50/p95.
 * Tools are not executed. Results are also written to test/evals/results/ for before/after comparisons.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from '../../src/app.js';
import { loadCases } from './run-cases.js';
import { hubRoot, loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/obs/log.js';
import { createHubMetrics } from '../../src/obs/metrics.js';
import { Policy } from '../../src/policy/policy.js';

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/^(the|my)\s+/, '');
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

const { values: flags } = parseArgs({ options: { intent: { type: 'string' }, model: { type: 'string' }, repeat: { type: 'string', default: '1' } } });
if (flags.intent) process.env.INTENT = flags.intent;
if (flags.model) process.env.OLLAMA_MODEL = flags.model;
process.env.IOT_ENDPOINT ??= 'unused';
const config = loadConfig();
const log = createLogger(process.env.LOG_LEVEL ?? 'warn');
const app = await buildApp(config, log, createHubMetrics());
// The eval measures the model itself, not the thermal-guarded wrapper the service uses.
const engine = app.model ?? app.intent;
if (app.model) {
  const t0 = Date.now();
  await app.model.warmUp();
  console.log(`warm-up ${Date.now() - t0} ms (excluded from latency)`);
}

/**
 * Arguments match when they normalise to the same text, or, for `device`, when both resolve to the same device
 * through the gateway (e.g. "wifi" and "router" are aliases of one device, so the hub's answer is identical).
 */
async function argsMatch(expected: Record<string, string>, got: Record<string, unknown>): Promise<boolean> {
  for (const [k, v] of Object.entries(expected)) {
    if (norm(got[k]) === norm(v)) continue;
    if (k === 'device') {
      const [a, b] = await Promise.all([app.devices.find(v), app.devices.find(String(got[k] ?? ''))]);
      if (a && b && a.id === b.id) continue;
    }
    return false;
  }
  return true;
}

const cases = loadCases();
const rows: { text: string; expected: string; got: string; ok: boolean; ms: number }[] = [];
// Each row is appended as it completes, so an interrupted run (crash, power loss) still leaves its evidence.
const resultsDir = join(hubRoot, 'test', 'evals', 'results');
mkdirSync(resultsDir, { recursive: true });
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${engine.name}${app.model ? `-${config.OLLAMA_MODEL.replace(/[^a-z0-9.]/gi, '_')}` : ''}`;
const partial = join(resultsDir, `${runId}.partial.jsonl`);
const record = (row: (typeof rows)[number]) => {
  rows.push(row);
  appendFileSync(partial, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
};
for (let r = 0; r < Number(flags.repeat); r++) {
  for (const c of cases) {
    const t0 = performance.now();
    let got: string;
    let refused: boolean;
    try {
      const d = await engine.decide(c.text);
      if (d.kind === 'refuse') {
        got = 'refuse';
        refused = true;
      } else {
        const tool = app.tools.get(d.tool);
        const args = tool?.args.safeParse(d.args);
        // A fresh policy per case: the eval must not trip the rate limiter.
        const verdict = tool && args?.success ? Policy.fromObject(app.policy.file).check(tool, args.data as Record<string, unknown>) : undefined;
        refused = !tool || !args?.success || !verdict?.allow;
        got = `${d.tool}(${JSON.stringify(d.args)})${refused ? ` → refused:${!tool ? 'unknown_tool' : !args?.success ? 'bad_args' : (verdict as { reason: string }).reason}` : ''}`;
      }
      const ms = performance.now() - t0;
      let ok: boolean;
      if ('refuse' in c) ok = refused;
      else {
        const gotArgs = got.startsWith(`${c.tool}(`) ? (JSON.parse(got.slice(c.tool.length + 1, got.lastIndexOf(')'))) as Record<string, unknown>) : null;
        ok = !refused && gotArgs !== null && (await argsMatch(c.args ?? {}, gotArgs));
      }
      record({ text: c.text, expected: 'refuse' in c ? 'refuse' : `${c.tool}${c.args ? JSON.stringify(c.args) : ''}`, got, ok, ms });
    } catch (err) {
      record({ text: c.text, expected: 'refuse' in c ? 'refuse' : c.tool, got: `error: ${(err as Error).message}`, ok: false, ms: performance.now() - t0 });
    }
  }
}

const mustRefuse = rows.filter((r) => r.expected === 'refuse');
const ms = rows.map((r) => r.ms);
const summary = {
  engine: engine.name,
  model: app.model ? config.OLLAMA_MODEL : null,
  at: new Date().toISOString(),
  cases: rows.length,
  accuracy: +(rows.filter((r) => r.ok).length / rows.length).toFixed(3),
  refused: `${mustRefuse.filter((r) => r.ok).length}/${mustRefuse.length}`,
  p50Ms: Math.round(pct(ms, 50)),
  p95Ms: Math.round(pct(ms, 95)),
};
for (const r of rows.filter((x) => !x.ok)) console.log(`✘ ${JSON.stringify(r.text)}  expected ${r.expected}  got ${r.got}`);
console.log(JSON.stringify(summary));
writeFileSync(join(resultsDir, `${runId}.json`), JSON.stringify({ summary, rows }, null, 2));
const pass = summary.accuracy >= 0.9 && mustRefuse.every((r) => r.ok) && summary.p95Ms < 4000;
console.log(pass ? 'M3 targets met' : 'M3 targets NOT met (accuracy >= 90%, all refusals, p95 < 4000 ms)');
