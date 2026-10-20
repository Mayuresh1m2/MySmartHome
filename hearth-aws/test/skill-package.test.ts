import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = resolve(import.meta.dirname, '..', 'skill-package');
const manifest = JSON.parse(readFileSync(join(pkg, 'skill.json'), 'utf8')).manifest;
const example = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'config', 'example.json'), 'utf8'));
const models = readdirSync(join(pkg, 'interactionModels', 'custom'));
const model = JSON.parse(readFileSync(join(pkg, 'interactionModels', 'custom', 'en-IN.json'), 'utf8')).interactionModel.languageModel;

describe('skill package follows the hearth-aws skill rules', () => {
  it('locale matches config (en-IN by default) in both manifest and model', () => {
    expect(models).toEqual([`${example.locale}.json`]);
    expect(Object.keys(manifest.publishingInformation.locales)).toEqual([example.locale]);
  });

  it('invocation name is the two-word "home hearth"', () => {
    expect(model.invocationName).toBe('home hearth');
  });

  it('one CommandIntent with slot command of COMMAND_TEXT and the single sample {command}', () => {
    const cmd = model.intents.find((i: { name: string }) => i.name === 'CommandIntent');
    expect(cmd.slots).toEqual([{ name: 'command', type: 'COMMAND_TEXT' }]);
    expect(cmd.samples).toEqual(['{command}']);
  });

  it('keeps Help, Stop, Cancel and NavigateHome; no FallbackIntent; no AMAZON.SearchQuery', () => {
    const names = model.intents.map((i: { name: string }) => i.name).sort();
    expect(names).toEqual(['AMAZON.CancelIntent', 'AMAZON.HelpIntent', 'AMAZON.NavigateHomeIntent', 'AMAZON.StopIntent', 'CommandIntent']);
    expect(JSON.stringify(model)).not.toContain('SearchQuery');
  });

  it('COMMAND_TEXT has 15 to 20 distinct sample values', () => {
    const values = model.types.find((t: { name: string }) => t.name === 'COMMAND_TEXT').values.map((v: { name: { value: string } }) => v.name.value);
    expect(values.length).toBeGreaterThanOrEqual(15);
    expect(values.length).toBeLessThanOrEqual(20);
    expect(new Set(values).size).toBe(values.length);
  });

  it('every handler the Lambda implements has an intent, and vice versa', () => {
    const handled = readFileSync(resolve(import.meta.dirname, '..', 'lambda', 'skill', 'src', 'skill.ts'), 'utf8');
    for (const i of model.intents) expect(handled).toContain(`'${i.name}'`);
  });

  it('example phrases use the invocation name, and the endpoint is a placeholder (no account ids committed)', () => {
    for (const p of manifest.publishingInformation.locales['en-IN'].examplePhrases) expect(p).toMatch(/^Alexa, (open|ask) home hearth/);
    expect(manifest.apis.custom.endpoint.uri).toMatch(/^REPLACE_WITH/);
    expect(JSON.stringify(manifest)).not.toMatch(/\d{12}/);
  });
});
