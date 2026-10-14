import { pino, type Logger, type DestinationStream } from 'pino';
import { LOG_REDACT_PATHS } from './redact.js';

export function createLogger(level = 'info', destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
      base: { service: 'nexus-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
