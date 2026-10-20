import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const contractsRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(contractsRoot, rel), 'utf8')) as Record<string, unknown>;
}

export const cloudHubV1 = {
  command: readJson('cloud-hub/v1/command.schema.json'),
  reply: readJson('cloud-hub/v1/reply.schema.json'),
  constants: readJson('cloud-hub/v1/constants.json') as {
    v: 1;
    region: string;
    hubIdPattern: string;
    defaultHubId: string;
    clientIdPrefix: string;
    commandsTopic: string;
    repliesTopic: string;
    qos: 1;
    alexaWaitMs: number;
    replyTimeoutMsDefault: number;
    replyTimeoutMsMax: number;
    hubStaleAfterMs: number;
    replyTtlSeconds: number;
  },
};

export const localDevicesV0 = {
  meta: readJson('local-devices/v0/meta.schema.json'),
  state: readJson('local-devices/v0/state.schema.json'),
  set: readJson('local-devices/v0/set.schema.json'),
  result: readJson('local-devices/v0/result.schema.json'),
};

export interface Fixture {
  file: string;
  /** Message kind derived from the file name prefix, e.g. "command" or "reply". */
  kind: string;
  /** Raw text, because some invalid fixtures are deliberately not JSON. */
  raw: string;
}

/** Lists fixtures for one contract, e.g. fixtures('cloud-hub/v1', 'invalid'). */
export function fixtures(contract: string, validity: 'valid' | 'invalid'): Fixture[] {
  const dir = join(contractsRoot, contract, 'fixtures', validity);
  return readdirSync(dir)
    .sort()
    .map((file) => ({
      file,
      kind: file.split('-')[0] ?? '',
      raw: readFileSync(join(dir, file), 'utf8'),
    }));
}
