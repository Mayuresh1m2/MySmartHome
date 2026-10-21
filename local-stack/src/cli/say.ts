/** `pnpm local:say "<text>"`: what "Alexa, ask ramesh dude to <text>" would say, via the local stack. */
const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('usage: pnpm local:say "<text>"');
  process.exit(2);
}
const port = Number(process.env.CONTROL_PORT ?? 8886);
try {
  const res = await fetch(`http://127.0.0.1:${port}/say`, { method: 'POST', body: JSON.stringify({ text }) });
  const r = (await res.json()) as { speech: string; outcome: string; requestId: string | null; latencyMs: number };
  console.log(`🗣  ${r.speech}`);
  console.log(`   outcome=${r.outcome} latency=${r.latencyMs}ms requestId=${r.requestId ?? '-'}`);
  if (r.requestId) console.log(`   trace: pnpm hearth:trace ${r.requestId}`);
} catch {
  console.error(`local stack not reachable on 127.0.0.1:${port}. Start it with: pnpm local:up`);
  process.exit(1);
}
