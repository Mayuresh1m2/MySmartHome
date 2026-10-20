/** JSON logs and CloudWatch Embedded Metric Format, with no dependencies. */
export type Outcome = 'ok' | 'refused' | 'error' | 'timeout' | 'publish_failed' | 'bad_reply';

export interface Logger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export const consoleLogger: Logger = {
  info: (f, msg) => console.log(JSON.stringify({ level: 'info', svc: 'hearth-skill', msg, ...f })),
  warn: (f, msg) => console.log(JSON.stringify({ level: 'warn', svc: 'hearth-skill', msg, ...f })),
  error: (f, msg) => console.log(JSON.stringify({ level: 'error', svc: 'hearth-skill', msg, ...f })),
};

/** Writes one EMF record: namespace Hearth, dimensions HubId + Outcome, metrics ReplyLatency and Requests. */
export function emitMetrics(hubId: string, outcome: Outcome, latencyMs: number, write: (line: string) => void = console.log): void {
  write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Hearth',
            Dimensions: [['HubId', 'Outcome'], ['HubId']],
            Metrics: [
              { Name: 'ReplyLatency', Unit: 'Milliseconds' },
              { Name: 'Requests', Unit: 'Count' },
            ],
          },
        ],
      },
      HubId: hubId,
      Outcome: outcome,
      ReplyLatency: latencyMs,
      Requests: 1,
    }),
  );
}
