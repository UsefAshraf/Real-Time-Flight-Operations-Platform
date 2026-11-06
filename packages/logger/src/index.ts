import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  /** Override the output stream (used by tests). Defaults to stdout. */
  destination?: DestinationStream;
}

/** Paths whose values must never reach log storage. */
export const REDACT_PATHS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'passportNumber',
  '*.password',
  '*.token',
  '*.passportNumber',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

export function createLogger({
  service,
  level = 'info',
  destination,
}: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
