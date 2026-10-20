import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/obs.js';
import type { CommandPublisher, ReplyStore } from '../src/ports.js';
import { SPEECH, createSkill, escapeSsml } from '../src/skill.js';
import { SKILL_ID, command, intent, launch, sessionEnded, speechOf } from './envelopes.js';

function setup(opts: { speech?: string; status?: string; silent?: boolean; debugUtterances?: boolean } = {}) {
  const logs: Record<string, unknown>[] = [];
  const metrics: string[] = [];
  const table = new Map<string, Record<string, unknown>>();
  const publisher: CommandPublisher = {
    async publish(_t, cmd) {
      if (!opts.silent) table.set(cmd.requestId, { v: 1, requestId: cmd.requestId, speech: opts.speech ?? 'Hub is online.', status: opts.status ?? 'ok' });
    },
  };
  const replies: ReplyStore = { get: async (id) => table.get(id) };
  const log: Logger = { info: (f, msg) => logs.push({ ...f, msg }), warn: (f, msg) => logs.push({ ...f, msg }), error: (f, msg) => logs.push({ ...f, msg }) };
  const skill = createSkill({ hubId: 'laptop', replyTimeoutMs: 300, pollIntervalMs: 10, skillId: SKILL_ID, publisher, replies, log, emit: (l) => metrics.push(l), debugUtterances: opts.debugUtterances });
  return { skill, logs, metrics };
}

describe('skill handlers', () => {
  it('Launch greets and keeps the session open', async () => {
    const r = await setup().skill.invoke(launch());
    expect(speechOf(r)).toBe(SPEECH.launch);
    expect(r.response.shouldEndSession).toBe(false);
  });

  it('CommandIntent speaks the hub reply and ends the session', async () => {
    const r = await setup().skill.invoke(command('ping'));
    expect(speechOf(r)).toBe('Hub is online.');
    expect(r.response.shouldEndSession).toBe(true);
  });

  it('speaks an honest fallback when the hub is off', async () => {
    const r = await setup({ silent: true }).skill.invoke(command('ping'));
    expect(speechOf(r)).toBe(SPEECH.timeout);
  });

  it('escapes hub speech so it cannot break SSML', async () => {
    const r = await setup({ speech: 'Tom & Jerry <audio src="x"/>' }).skill.invoke(command('x'));
    expect(speechOf(r)).toBe('Tom &amp; Jerry &lt;audio src="x"/&gt;');
  });

  it('asks again when the slot is empty', async () => {
    const r = await setup().skill.invoke(command(undefined));
    expect(speechOf(r)).toBe(SPEECH.noCommand);
    expect(r.response.shouldEndSession).toBe(false);
  });

  it('Help, Stop, Cancel and NavigateHome', async () => {
    const { skill } = setup();
    expect(speechOf(await skill.invoke(intent('AMAZON.HelpIntent')))).toBe(SPEECH.help);
    for (const name of ['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent']) {
      const r = await skill.invoke(intent(name));
      expect(speechOf(r), name).toBe(SPEECH.goodbye);
      expect(r.response.shouldEndSession).toBe(true);
    }
  });

  it('SessionEnded returns an empty response', async () => {
    const r = await setup().skill.invoke(sessionEnded());
    expect(r.response.outputSpeech).toBeUndefined();
  });

  it('unknown intents (e.g. FallbackIntent) get the error handler, not a crash', async () => {
    const r = await setup().skill.invoke(intent('AMAZON.FallbackIntent'));
    expect(speechOf(r)).toBe(SPEECH.error);
  });

  it('rejects requests from another skill (withSkillId)', async () => {
    await expect(setup().skill.invoke(command('ping', 'amzn1.ask.skill.someone-else'))).rejects.toThrow();
  });

  it('logs requestId, latency and outcome but not the utterance by default', async () => {
    const s = setup();
    await s.skill.invoke(command('how much space is left'));
    const line = s.logs.find((l) => l.msg === 'command relayed')!;
    expect(line).toMatchObject({ hubId: 'laptop', outcome: 'ok', textLength: 22 });
    expect(line.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof line.latencyMs).toBe('number');
    expect(line.text).toBeUndefined();
  });

  it('logs the utterance only with DEBUG_UTTERANCES', async () => {
    const s = setup({ debugUtterances: true });
    await s.skill.invoke(command('how much space is left'));
    expect(s.logs.find((l) => l.msg === 'command relayed')?.text).toBe('how much space is left');
  });

  it('emits one EMF record per command', async () => {
    const s = setup({ silent: true });
    await s.skill.invoke(command('ping'));
    const emf = JSON.parse(s.metrics[0]!);
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe('Hearth');
    expect(emf).toMatchObject({ HubId: 'laptop', Outcome: 'timeout', Requests: 1 });
  });
});

describe('escapeSsml', () => {
  it('escapes markup characters and leaves quotes', () => {
    expect(escapeSsml(`a&b<c>d"e'f`)).toBe(`a&amp;b&lt;c&gt;d"e'f`);
  });
});
