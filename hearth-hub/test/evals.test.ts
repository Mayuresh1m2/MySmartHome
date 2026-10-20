import { describe, expect, it } from 'vitest';
import { loadCases } from './evals/run-cases.js';

describe('eval set', () => {
  const cases = loadCases();
  it('has at least 40 phrasings, including must-refuse ones for deleting, unlocking and things no tool does', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    const refusals = cases.filter((c) => 'refuse' in c).map((c) => c.text);
    expect(refusals.some((t) => /delete|remove/.test(t))).toBe(true);
    expect(refusals.some((t) => /unlock/.test(t))).toBe(true);
    expect(refusals.some((t) => /joke|pizza|weather/.test(t))).toBe(true);
  });
  it('covers every built-in tool and has no duplicate phrasings', () => {
    const tools = new Set(cases.flatMap((c) => ('tool' in c ? [c.tool] : [])));
    expect([...tools].sort()).toEqual(['disk_space', 'is_device_online', 'last_result', 'list_folder', 'ping']);
    expect(new Set(cases.map((c) => c.text)).size).toBe(cases.length);
  });
});
