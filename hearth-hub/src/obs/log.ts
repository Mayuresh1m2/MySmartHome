import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    base: { svc: 'hearth-hub' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Defence in depth: TLS material must never reach a log line.
    redact: { paths: ['key', '*.key', 'cert', '*.cert', 'ca', '*.ca'], censor: '[redacted]' },
  });
}
