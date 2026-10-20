import type { Risk } from '../tools/types.js';

/** A capability as published by hearth-devices (Matter-style name, JSON Schema params, risk class). */
export interface DeviceCapability {
  name: string;
  risk: Risk;
  params: Record<string, unknown>;
}

export interface DeviceInfo {
  id: string;
  name: string;
  aliases?: string[];
  room?: string;
  kind?: string;
  capabilities: DeviceCapability[];
}

export interface DeviceState {
  online: boolean;
  values: Record<string, unknown>;
}

export interface ExecuteResult {
  ok: boolean;
  /** Short, user-safe reason when ok is false. */
  error: string | null;
  state: Record<string, unknown>;
}

/**
 * How the hub reaches devices. Tools only ever see this interface, so implementations
 * (devices.json today, the hearth-devices MQTT bus later, fakes in tests) are interchangeable.
 */
export interface DeviceGateway {
  readonly name: string;
  list(): Promise<DeviceInfo[]>;
  /** Finds a device by id, name or alias (case-insensitive, ignores a leading "the"/"my"). */
  find(nameOrAlias: string): Promise<DeviceInfo | undefined>;
  getState(id: string): Promise<DeviceState>;
  execute(id: string, capability: string, params: Record<string, unknown>, ctx: { requestId: string }): Promise<ExecuteResult>;
}

export function normaliseName(q: string): string {
  return q.trim().toLowerCase().replace(/^(the|my)\s+/, '');
}

export function matches(d: DeviceInfo, q: string): boolean {
  const n = normaliseName(q);
  return d.id === n || d.name.toLowerCase() === n || (d.aliases ?? []).some((a) => a.toLowerCase() === n);
}
