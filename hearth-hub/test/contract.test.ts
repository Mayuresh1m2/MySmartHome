import { fixtures } from '@hearth/contracts';
import { describe, expect, it } from 'vitest';
import { CommandV1, ReplyV1, makeReply, parseCommand } from '../src/relay/schema.js';

const schemas = { command: CommandV1, reply: ReplyV1 } as const;

describe('zod schemas agree with contracts/cloud-hub/v1 fixtures', () => {
  for (const fx of fixtures('cloud-hub/v1', 'valid')) {
    it(`accepts ${fx.file}`, () => {
      expect(schemas[fx.kind as keyof typeof schemas].safeParse(JSON.parse(fx.raw)).success).toBe(true);
    });
  }
  for (const fx of fixtures('cloud-hub/v1', 'invalid')) {
    it(`rejects ${fx.file}`, () => {
      let data: unknown;
      try {
        data = JSON.parse(fx.raw);
      } catch {
        return; // not JSON: covered by parseCommand tests
      }
      expect(schemas[fx.kind as keyof typeof schemas].safeParse(data).success).toBe(false);
    });
  }
});

describe('parseCommand', () => {
  const good = { v: 1, requestId: '0b9e6a8e-6f8c-4a53-9d1e-2f0e7c1d4a10', text: 'ping', sentAt: 1 };

  it('accepts a valid command', () => {
    expect(parseCommand(Buffer.from(JSON.stringify(good)))).toEqual({ ok: true, command: good });
  });
  it('rejects non-JSON', () => {
    expect(parseCommand('nope')).toMatchObject({ ok: false, reason: 'not_json' });
  });
  it('rejects a wrong version and still reports the requestId for logs', () => {
    expect(parseCommand(JSON.stringify({ ...good, v: 2 }))).toMatchObject({
      ok: false,
      reason: 'wrong_version',
      requestId: good.requestId,
    });
  });
  it('rejects unknown fields', () => {
    expect(parseCommand(JSON.stringify({ ...good, exec: 'rm -rf /' }))).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('rejects JSON that is not an object', () => {
    expect(parseCommand('42')).toMatchObject({ ok: false });
    expect(parseCommand('null')).toMatchObject({ ok: false });
  });
});

describe('makeReply', () => {
  const id = '0b9e6a8e-6f8c-4a53-9d1e-2f0e7c1d4a10';
  it('clamps long speech to the contract limit', () => {
    const r = makeReply(id, 'a'.repeat(1000), 'ok');
    expect(r.speech.length).toBe(400);
    expect(ReplyV1.safeParse(r).success).toBe(true);
  });
  it('never produces empty speech', () => {
    expect(makeReply(id, '   ', 'ok').speech).toBe('Done.');
  });
});
