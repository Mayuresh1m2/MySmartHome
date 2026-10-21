import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit.js';
import type { Decision, IntentEngine } from '../src/intent/types.js';
import { createHubMetrics } from '../src/obs/metrics.js';
import { createPipeline } from '../src/pipeline.js';
import { Policy } from '../src/policy/policy.js';
import { ReplyV1 } from '../src/relay/schema.js';
import { StateStore } from '../src/state/store.js';
import { toolMap } from '../src/tools/index.js';
import { defineTool, type Tool } from '../src/tools/types.js';
import { ctx, silentLog } from './helpers.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const fixed = (d: Decision): IntentEngine => ({ name: 'fixed', decide: async () => d });
const boom = defineTool({ name: 'boom', description: 'always throws an error', args: z.object({}), risk: 'read', run: async () => { throw new Error('kaput'); } });
const lamp = defineTool({ name: 'lamp_on', description: 'turns a lamp on', args: z.object({}), risk: 'low', run: async () => ({ speech: 'on' }) });

function setup(decision: Decision, opts: { auditText?: boolean; policy?: object } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-audit-'));
  dirs.push(dir);
  const metrics = createHubMetrics();
  const state = new StateStore();
  const policy = Policy.fromObject(
    opts.policy ?? { version: 1, tools: { ping: { enabled: true }, list_folder: { enabled: true }, boom: { enabled: true }, lamp_on: { enabled: true } } },
  );
  const tools = toolMap([...toolMap().values(), boom, lamp] as Tool[]);
  const c = ctx();
  const audit = new AuditLog(dir, opts.auditText ?? true);
  const handle = createPipeline({
    intent: fixed(decision),
    policy,
    tools,
    audit,
    state,
    log: silentLog,
    metrics,
    toolContext: { log: c.log, state, devices: c.devices, fs: c.fs },
  });
  /** The pipeline does not wait for the audit write, so flush before reading. */
  const auditLines = async () => {
    await audit.flush();
    return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  };
  return { handle, metrics, state, auditLines };
}

const cmd = { requestId: '0b9e6a8e-6f8c-4a53-9d1e-2f0e7c1d4a10', text: 'do the thing' };

describe('pipeline', () => {
  it('runs an allowed tool, replies ok, audits and records state', async () => {
    const s = setup({ kind: 'tool', tool: 'ping', args: {} });
    const r = await s.handle(cmd);
    expect(ReplyV1.parse(r.reply)).toMatchObject({ status: 'ok', speech: 'Hub is online.' });
    expect(r.decision).toBe('allowed');
    expect(Object.keys(r.stages)).toEqual(expect.arrayContaining(['intent', 'policy', 'tool', 'total']));
    const [line] = await s.auditLines();
    expect(line).toMatchObject({ requestId: cmd.requestId, text: 'do the thing', tool: 'ping', decision: 'allowed', outcome: 'ok' });
    expect(s.state.lastResult()?.tool).toBe('ping');
    expect(s.metrics.commands.get({ outcome: 'ok' })).toBe(1);
  });

  it('refuses when the intent refuses', async () => {
    const s = setup({ kind: 'refuse', speech: 'No.' });
    const r = await s.handle(cmd);
    expect(r.reply).toMatchObject({ status: 'refused', speech: 'No.' });
    expect(r.decision).toBe('refused:intent');
  });

  it('refuses a tool the model invented', async () => {
    const r = await setup({ kind: 'tool', tool: 'run_shell', args: { cmd: 'rm -rf /' } }).handle(cmd);
    expect(r).toMatchObject({ decision: 'refused:unknown_tool', reply: { status: 'refused' } });
  });

  it('refuses arguments that fail the tool schema', async () => {
    const r = await setup({ kind: 'tool', tool: 'list_folder', args: { folder: '../../etc' } }).handle(cmd);
    expect(r).toMatchObject({ decision: 'refused:bad_args', reply: { status: 'refused' } });
  });

  it('refuses a real tool that policy does not list', async () => {
    const r = await setup({ kind: 'tool', tool: 'disk_space', args: {} }).handle(cmd);
    expect(r).toMatchObject({ decision: 'refused:not_in_policy', reply: { status: 'refused' } });
  });

  it('refuses above the voice ceiling', async () => {
    const r = await setup({ kind: 'tool', tool: 'lamp_on', args: {} }).handle(cmd);
    expect(r.decision).toBe('refused:risk');
  });

  it('turns a tool exception into an error reply without leaking the message', async () => {
    const r = await setup({ kind: 'tool', tool: 'boom', args: {} }).handle(cmd);
    expect(r.reply).toMatchObject({ status: 'error', speech: 'Sorry, something went wrong on the hub.' });
    expect(r.reply.speech).not.toContain('kaput');
  });

  it('audits only the text length when AUDIT_TEXT=false', async () => {
    const s = setup({ kind: 'tool', tool: 'ping', args: {} }, { auditText: false });
    await s.handle(cmd);
    const [line] = await s.auditLines();
    expect(line.text).toBeUndefined();
    expect(line.textLength).toBe(cmd.text.length);
  });

  it('audit lines from concurrent commands do not interleave', async () => {
    const s = setup({ kind: 'tool', tool: 'ping', args: {} });
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.handle({ requestId: `${cmd.requestId.slice(0, -2)}${String(i).padStart(2, '0')}`, text: 'x' })));
    expect(await s.auditLines()).toHaveLength(20);
  });
});

describe('audit retention', () => {
  it('prunes day files older than the retention, keeps recent and foreign files', async () => {
    const { writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'hearth-prune-'));
    dirs.push(dir);
    for (const f of ['2026-06-01.jsonl', '2026-07-22.jsonl', '2026-07-23.jsonl', '2026-10-20.jsonl', 'notes.txt']) writeFileSync(join(dir, f), '');
    const removed = await new AuditLog(dir, true).prune(90, Date.parse('2026-10-21T00:00:00Z'));
    expect(removed.sort()).toEqual(['2026-06-01.jsonl', '2026-07-22.jsonl']);
    expect(readdirSync(dir).sort()).toEqual(['2026-07-23.jsonl', '2026-10-20.jsonl', 'notes.txt']);
  });
});
