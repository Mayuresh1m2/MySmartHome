import type { z } from 'zod';
import type { DeviceGateway } from '../devices/gateway.js';
import type { Logger } from '../obs/log.js';
import type { StateStore } from '../state/store.js';

export type Risk = 'read' | 'low' | 'medium' | 'high';
export const RISK_ORDER: Record<Risk, number> = { read: 0, low: 1, medium: 2, high: 3 };

/** Filesystem calls tools may use; injectable so tests never touch the real disk. */
export interface ToolFs {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; isDirectory(): boolean }>;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bavail: number }>;
}

export interface ToolContext {
  log: Logger;
  state: StateStore;
  devices: DeviceGateway;
  fs: ToolFs;
  /** Tool-specific settings from policy.yaml (e.g. the folder aliases for list_folder). */
  settings: Record<string, unknown>;
}

export interface ToolResult {
  /** One or two sentences. This leaves the house through Amazon: never secrets, tokens, IPs or paths. */
  speech: string;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  args: S;
  risk: Risk;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export const defineTool = <S extends z.ZodType>(t: Tool<S>): Tool<S> => t;
