import { z } from 'zod';
import type { DeviceGateway, DeviceInfo } from '../devices/gateway.js';
import { RISK_ORDER, defineTool, type Risk, type Tool } from './types.js';

/** "RvcRunMode" → "device_rvc_run_mode" */
export function toolNameFor(capability: string): string {
  return `device_${capability.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase()}`;
}

/** Capabilities that never become voice tools: high risk (spec), and reachability (is_device_online covers it). */
const SKIP = new Set(['Reachability']);

/**
 * One tool per capability name across the gateway's devices. Arguments are `{device, params}`, with params
 * built from the capability's JSON Schema. Generated tools still go through hub policy like any other tool,
 * so they are refused unless policy.yaml lists them.
 */
export async function generateDeviceTools(gateway: DeviceGateway): Promise<Tool[]> {
  const byCap = new Map<string, { risk: Risk; params: Record<string, unknown>; devices: DeviceInfo[] }>();
  for (const d of await gateway.list()) {
    for (const c of d.capabilities) {
      if (SKIP.has(c.name) || c.risk === 'high') continue;
      const entry = byCap.get(c.name) ?? { risk: c.risk, params: c.params, devices: [] };
      // If devices disagree, the tool carries the highest risk; the adapter still validates its own params.
      if (RISK_ORDER[c.risk] > RISK_ORDER[entry.risk]) entry.risk = c.risk;
      entry.devices.push(d);
      byCap.set(c.name, entry);
    }
  }
  return [...byCap].map(([capability, { risk, params, devices }]) => {
    const paramsSchema = Object.keys(params).length ? z.fromJSONSchema(params) : z.object({});
    return defineTool({
      name: toolNameFor(capability),
      description: `Use the ${capability} capability on one of: ${devices.map((d) => d.name).join(', ')}.`,
      args: z.object({ device: z.string().trim().toLowerCase().min(1).max(40), params: paramsSchema }),
      risk,
      async run({ device, params: p }, ctx) {
        const d = await ctx.devices.find(device);
        if (!d) return { speech: `I don't know a device called ${device}.` };
        if (!d.capabilities.some((c) => c.name === capability)) return { speech: `The ${d.name} can't do that.` };
        const r = await ctx.devices.execute(d.id, capability, p as Record<string, unknown>, { requestId: ctx.requestId ?? 'unknown' });
        return { speech: r.ok ? `Done. ${describe(d.name, r.state)}`.trim() : `The ${d.name} couldn't do that: ${r.error ?? 'unknown error'}.` };
      },
    }) as unknown as Tool;
  });
}

/** A short spoken summary of common state values; anything else is left out. */
function describe(name: string, state: Record<string, unknown>): string {
  if (typeof state.on === 'boolean') return `The ${name} is ${state.on ? 'on' : 'off'}.`;
  if (typeof state.operationalState === 'string') return `The ${name} is ${state.operationalState}.`;
  return '';
}
