import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { localDevicesV0 } from '@hearth/contracts';

export type Risk = 'read' | 'low' | 'medium' | 'high';

export interface Capability {
  name: string;
  /** JSON Schema for the command params. */
  params: Record<string, unknown>;
  risk: Risk;
}

export interface DeviceMeta {
  v: 0;
  id: string;
  name: string;
  room: string;
  kind: string;
  adapter: string;
  capabilities: Capability[];
}

export interface SetCommand {
  v: 0;
  requestId: string;
  capability: string;
  action: string;
  params: Record<string, unknown>;
}

export interface Result {
  v: 0;
  requestId: string;
  ok: boolean;
  error: string | null;
  state: Record<string, unknown>;
}

export const ROOT = 'hearth/local';
export const SET_FILTER = `${ROOT}/devices/+/set`;
export const deviceTopic = (id: string, kind: 'meta' | 'state' | 'set' | 'result') => `${ROOT}/devices/${id}/${kind}`;
export const adapterStatusTopic = (id: string) => `${ROOT}/adapters/${id}/status`;

export const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats.default(ajv);
const validators = {
  meta: ajv.compile(localDevicesV0.meta),
  state: ajv.compile(localDevicesV0.state),
  set: ajv.compile(localDevicesV0.set),
  result: ajv.compile(localDevicesV0.result),
};

/** Throws if doc breaks contracts/local-devices/v0. */
export function validate(kind: keyof typeof validators, doc: unknown): void {
  const v = validators[kind];
  if (!v(doc)) throw new Error(`${kind} breaks contract: ${ajv.errorsText(v.errors)}`);
}

export function isValid(kind: keyof typeof validators, doc: unknown): boolean {
  return validators[kind](doc);
}

export function statePayload(online: boolean, values: Record<string, unknown> = {}): Record<string, unknown> {
  for (const k of ['v', 'online', 'updatedAt']) if (k in values) throw new Error(`state values may not use reserved key ${k}`);
  return { v: 0, online, updatedAt: Date.now(), ...values };
}
