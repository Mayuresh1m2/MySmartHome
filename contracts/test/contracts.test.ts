import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { cloudHubV1, contractsRoot, fixtures, localDevicesV0 } from '../src/index.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(ajv);

const validators = {
  'cloud-hub/v1': { command: ajv.compile(cloudHubV1.command), reply: ajv.compile(cloudHubV1.reply) },
  'local-devices/v0': {
    meta: ajv.compile(localDevicesV0.meta),
    state: ajv.compile(localDevicesV0.state),
    set: ajv.compile(localDevicesV0.set),
    result: ajv.compile(localDevicesV0.result),
  },
} as const;

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return Symbol('not-json');
  }
}

for (const [contract, byKind] of Object.entries(validators)) {
  describe(contract, () => {
    for (const fx of fixtures(contract, 'valid')) {
      it(`accepts ${fx.file}`, () => {
        const validate = byKind[fx.kind as keyof typeof byKind] as ((d: unknown) => boolean) | undefined;
        expect(validate, `no schema for kind ${fx.kind}`).toBeDefined();
        expect(validate!(parse(fx.raw))).toBe(true);
      });
    }
    for (const fx of fixtures(contract, 'invalid')) {
      it(`rejects ${fx.file}`, () => {
        const validate = byKind[fx.kind as keyof typeof byKind] as ((d: unknown) => boolean) | undefined;
        expect(validate, `no schema for kind ${fx.kind}`).toBeDefined();
        expect(validate!(parse(fx.raw))).toBe(false);
      });
    }
  });
}

describe('spec drift', () => {
  // Both CLAUDE.md files promise an identical contract section; fail loudly if they diverge.
  function contractSection(file: string, heading: string): string {
    const text = readFileSync(join(contractsRoot, '..', file), 'utf8');
    const start = text.indexOf(`## ${heading}`);
    expect(start, `${file} lacks "## ${heading}"`).toBeGreaterThanOrEqual(0);
    const body = text.slice(text.indexOf('\n', start) + 1);
    const end = body.search(/^## /m);
    return (end === -1 ? body : body.slice(0, end)).trim();
  }

  it('hearth-aws and hearth-hub contract sections are identical', () => {
    const aws = contractSection('hearth-aws/CLAUDE.md', 'Contract with hearth-hub');
    const hub = contractSection('hearth-hub/CLAUDE.md', 'Contract with hearth-aws');
    expect(hub).toBe(aws);
  });

  it('constants.json agrees with the spec text', () => {
    const aws = contractSection('hearth-aws/CLAUDE.md', 'Contract with hearth-hub');
    const c = cloudHubV1.constants;
    expect(aws).toContain(`Region: \`${c.region}\``);
    expect(aws).toContain(`default \`${c.defaultHubId}\``);
    expect(aws).toContain(`(default ${c.replyTimeoutMsDefault}, never above ${c.replyTimeoutMsMax})`);
    expect(aws).toContain(`older than ${c.hubStaleAfterMs / 1000} s`);
    expect(aws).toContain(`QoS ${c.qos}`);
    expect(aws).toContain('"v":1');
  });
});
