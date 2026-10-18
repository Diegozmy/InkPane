import { config, type LogLevel } from '../config.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type LogFields = Record<string, unknown>;

function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: config.isProduction ? undefined : error.stack,
    };
  }
  return { errorMessage: String(error) };
}

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[config.logLevel]) return;

  const payload: LogFields = {
    time: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }

  const line = config.isProduction
    ? JSON.stringify(payload)
    : `${payload['time'] as string} ${level.toUpperCase().padEnd(5)} ${message}${
        Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ''
      }`;

  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write('debug', message, fields),
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, error?: unknown, fields?: LogFields) =>
    write('error', message, { ...fields, ...(error === undefined ? {} : serializeError(error)) }),
};

export type Logger = typeof logger;
