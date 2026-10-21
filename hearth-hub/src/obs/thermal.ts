import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface Temps {
  gpuC: number | null;
  cpuC: number | null;
}

/**
 * Reads the discrete GPU (amdgpu) and CPU package (coretemp) temperatures from hwmon. No root needed.
 * Missing sensors read as null. `root` is injectable for tests.
 */
export async function readTemps(root = '/sys/class/hwmon'): Promise<Temps> {
  const out: Temps = { gpuC: null, cpuC: null };
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return out;
  }
  for (const e of entries) {
    try {
      const name = (await readFile(join(root, e, 'name'), 'utf8')).trim();
      if (name !== 'amdgpu' && name !== 'coretemp') continue;
      const milli = Number((await readFile(join(root, e, 'temp1_input'), 'utf8')).trim());
      if (!Number.isFinite(milli)) continue;
      if (name === 'amdgpu') out.gpuC = Math.max(out.gpuC ?? -Infinity, milli / 1000);
      else out.cpuC = Math.max(out.cpuC ?? -Infinity, milli / 1000);
    } catch {
      // a sensor that disappears mid-read is just missing
    }
  }
  return out;
}

export interface ThermalGuardOptions {
  gpuMaxC: number;
  cpuMaxC: number;
  /** Once hot, stay hot until this many degrees below the limit, so the guard doesn't flap. */
  hysteresisC?: number;
  /** Max model calls per rolling minute; protects against loops and request floods. */
  modelCallsPerMinute: number;
  read?: () => Promise<Temps>;
  now?: () => number;
  /** Reuse a reading for this long, so a burst of commands doesn't hammer sysfs. */
  cacheMs?: number;
}

export type GuardVerdict = { allow: true; temps: Temps } | { allow: false; reason: 'gpu_hot' | 'cpu_hot' | 'rate'; temps: Temps };

/**
 * Decides whether the hub may use the local model right now. This laptop's GPU and CPU share one cooler, and
 * sustained inference once drove them to 110 °C / 98 °C and a thermal power-off (progress/21).
 */
export class ThermalGuard {
  private hot: 'gpu_hot' | 'cpu_hot' | null = null;
  private last?: { at: number; temps: Temps };
  private calls: number[] = [];

  constructor(private readonly o: ThermalGuardOptions) {}

  async temps(): Promise<Temps> {
    const now = (this.o.now ?? Date.now)();
    if (this.last && now - this.last.at < (this.o.cacheMs ?? 2000)) return this.last.temps;
    const temps = await (this.o.read ?? readTemps)();
    this.last = { at: now, temps };
    return temps;
  }

  get state(): 'ok' | 'gpu_hot' | 'cpu_hot' {
    return this.hot ?? 'ok';
  }

  /** Call once per command before using the model. Counts the call when allowed. */
  async check(): Promise<GuardVerdict> {
    const temps = await this.temps();
    const hyst = this.o.hysteresisC ?? 5;
    const gpuLimit = this.hot === 'gpu_hot' ? this.o.gpuMaxC - hyst : this.o.gpuMaxC;
    const cpuLimit = this.hot === 'cpu_hot' ? this.o.cpuMaxC - hyst : this.o.cpuMaxC;
    if (temps.gpuC !== null && temps.gpuC >= gpuLimit) this.hot = 'gpu_hot';
    else if (temps.cpuC !== null && temps.cpuC >= cpuLimit) this.hot = 'cpu_hot';
    else this.hot = null;
    if (this.hot) return { allow: false, reason: this.hot, temps };

    const now = (this.o.now ?? Date.now)();
    this.calls = this.calls.filter((t) => now - t < 60_000);
    if (this.calls.length >= this.o.modelCallsPerMinute) return { allow: false, reason: 'rate', temps };
    this.calls.push(now);
    return { allow: true, temps };
  }
}
