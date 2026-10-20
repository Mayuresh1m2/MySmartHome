import { describe, expect, it } from 'vitest';
import { createHubMetrics } from '../src/obs/metrics.js';

describe('metrics', () => {
  it('renders Prometheus text with labels and histogram buckets', () => {
    const m = createHubMetrics();
    m.commands.inc({ outcome: 'ok' });
    m.commands.inc({ outcome: 'ok' });
    m.stageMs.observe(42, { stage: 'total' });
    m.mqttConnected.set(1);
    const text = m.registry.render();
    expect(text).toContain('# TYPE hearth_hub_commands_total counter');
    expect(text).toContain('hearth_hub_commands_total{outcome="ok"} 2');
    expect(text).toContain('hearth_hub_stage_duration_ms_bucket{stage="total",le="50"} 1');
    expect(text).toContain('hearth_hub_stage_duration_ms_bucket{stage="total",le="25"} 0');
    expect(text).toContain('hearth_hub_stage_duration_ms_count{stage="total"} 1');
    expect(text).toContain('hearth_hub_mqtt_connected 1');
  });

  it('escapes label values', () => {
    const m = createHubMetrics();
    m.commands.inc({ outcome: 'a"b' });
    expect(m.registry.render()).toContain('outcome="a\\"b"');
  });
});
