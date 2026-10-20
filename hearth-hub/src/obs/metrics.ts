/**
 * Minimal Prometheus text-format metrics (counters, gauges, histograms).
 * Kept dependency-free: prom-client is deprecated and the hub needs only a handful of series.
 */
type Labels = Record<string, string>;

const key = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${String(l[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {}
  abstract lines(): string[];
}

export class Counter extends Metric {
  private values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
  lines(): string[] {
    if (this.values.size === 0) return [`${this.name} 0`];
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`);
  }
}

export class Gauge extends Metric {
  private values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }
  set(value: number, labels: Labels = {}): void {
    this.values.set(key(labels), value);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
  lines(): string[] {
    if (this.values.size === 0) return [`${this.name} 0`];
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`);
  }
}

export class Histogram extends Metric {
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    name: string,
    help: string,
    readonly buckets: number[],
  ) {
    super(name, help, 'histogram');
  }
  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.series) {
      const pre = k ? `${k},` : '';
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket{${pre}le="${b}"} ${s.counts[i]}`));
      out.push(`${this.name}_bucket{${pre}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      out.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return out;
  }
}

export class Registry {
  private metrics: Metric[] = [];
  register<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }
  render(): string {
    return (
      this.metrics
        .flatMap((m) => [`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.lines()])
        .join('\n') + '\n'
    );
  }
}

const MS_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 3000, 4000, 6000, 10000];

/** The hub's metric set, one instance per process. */
export function createHubMetrics() {
  const registry = new Registry();
  return {
    registry,
    commands: registry.register(
      new Counter('hearth_hub_commands_total', 'Commands received, by outcome (ok|refused|error|stale|duplicate|invalid)'),
    ),
    stageMs: registry.register(
      new Histogram('hearth_hub_stage_duration_ms', 'Per-stage latency in ms (intent|policy|tool|publish|total)', MS_BUCKETS),
    ),
    mqttConnected: registry.register(new Gauge('hearth_hub_mqtt_connected', '1 when connected to the broker')),
    reconnects: registry.register(new Counter('hearth_hub_mqtt_reconnects_total', 'Reconnect attempts')),
    modelLoaded: registry.register(new Gauge('hearth_hub_model_loaded', '1 when the Ollama model is loaded')),
    lastCommandAt: registry.register(new Gauge('hearth_hub_last_command_timestamp_ms', 'Epoch ms of the last accepted command')),
  };
}

export type HubMetrics = ReturnType<typeof createHubMetrics>;
