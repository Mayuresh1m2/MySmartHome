import { describe, expect, it } from 'vitest';
import { CommandGuard } from '../src/relay/guard.js';

describe('CommandGuard', () => {
  let now = 1_000_000;
  const guard = () => new CommandGuard({ now: () => now });

  it('accepts a fresh command once, then flags the duplicate', () => {
    const g = guard();
    expect(g.check({ requestId: 'a', sentAt: now - 500 })).toEqual({ accept: true });
    expect(g.check({ requestId: 'a', sentAt: now - 500 })).toEqual({ accept: false, reason: 'duplicate' });
  });

  it('drops commands older than 10 s, accepts exactly 10 s', () => {
    const g = guard();
    expect(g.check({ requestId: 'b', sentAt: now - 10_000 })).toEqual({ accept: true });
    expect(g.check({ requestId: 'c', sentAt: now - 10_001 })).toEqual({ accept: false, reason: 'stale' });
  });

  it('drops commands from far in the future (clock skew)', () => {
    expect(guard().check({ requestId: 'd', sentAt: now + 10_001 })).toEqual({ accept: false, reason: 'future' });
  });

  it('a stale duplicate is reported as stale and does not refresh the memory', () => {
    const g = guard();
    g.check({ requestId: 'e', sentAt: now });
    now += 11_000;
    expect(g.check({ requestId: 'e', sentAt: now - 11_000 })).toEqual({ accept: false, reason: 'stale' });
  });

  it('forgets ids after the remember window', () => {
    const g = new CommandGuard({ now: () => now, rememberMs: 1000, staleAfterMs: 5000 });
    g.check({ requestId: 'f', sentAt: now });
    now += 1500;
    expect(g.recentIds()).toContain('f');
    g.check({ requestId: 'g', sentAt: now });
    expect(g.recentIds()).not.toContain('f');
  });
});
