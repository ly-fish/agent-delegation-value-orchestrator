import type { Logger } from '@dvo/core';
import { Redactor } from '@dvo/evidence';
import { pino, type Logger as PinoLogger } from 'pino';

/**
 * Structured JSON logs (pino) with two layers of redaction (invariant 6): pino's path-based
 * `redact` for well-known header locations, and the evidence Redactor applied to every log
 * object, so a credential pattern is scrubbed wherever it appears.
 */
export function createPino(level: string, destination?: NodeJS.WritableStream): PinoLogger {
  const redactor = new Redactor();
  return pino(
    {
      level,
      base: { service: 'harness-dvo' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
          '*.authorization',
          '*.apiKey',
          '*.token',
        ],
        censor: '[REDACTED]',
      },
      formatters: {
        log: (object) => redactor.redact(object).value,
      },
    },
    destination as never,
  );
}

/** Adapts pino to the core Logger port. */
export function toCoreLogger(logger: PinoLogger): Logger {
  return {
    debug: (fields, message) => logger.debug(fields, message),
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
    child: (bindings) => toCoreLogger(logger.child(bindings)),
  };
}
