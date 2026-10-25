import { describe, expect, it } from 'vitest';
import { KeywordRouter } from '../src/intent/keywordRouter.js';

const r = new KeywordRouter();
const cases: [string, string | null, Record<string, unknown>?][] = [
  ['how much space is left', 'disk_space'],
  ['How much disk space do I have?', 'disk_space'],
  ['ping', 'ping'],
  ['list my downloads folder', 'list_folder', { folder: 'downloads' }],
  ["what's in my documents", 'list_folder', { folder: 'documents' }],
  ['is the router online', 'is_device_online', { device: 'router' }],
  ['is my living room tv up', 'is_device_online', { device: 'living room tv' }],
  ['what happened', 'last_result'],
  ['clean the house', 'clean_house'],
  ['run the vacuum', 'clean_house'],
  ['is the vacuum okay', 'vacuum_status'],
  ['what is the vacuum doing', 'vacuum_status'],
  ['why did the vacuum stop', 'vacuum_status'],
  ['delete all my files', null],
  ['free up disk space', null],
  ['unlock the front door', null],
  ['remove my downloads folder', null],
  ['tell me a joke', null],
  ['format the disk', null],
  ['buy more storage', null],
];

describe('KeywordRouter', () => {
  for (const [text, tool, args] of cases) {
    it(`${JSON.stringify(text)} -> ${tool ?? 'refuse'}`, async () => {
      const d = await r.decide(text);
      if (tool === null) expect(d.kind).toBe('refuse');
      else expect(d).toEqual({ kind: 'tool', tool, args: args ?? {} });
    });
  }
});
