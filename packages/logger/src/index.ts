/**
 * Shared logger for the arb monorepo.
 *
 * Usage:
 *   import { createLogger } from '@arb/logger';
 *   const log = createLogger('stage1');
 *   log.info('Processing %d markets', count);
 *   log.warn('Skipped market %s:', id, err);
 *   log.error('Fatal:', err);
 *   log.debug('Detail:', obj);
 *
 * Env controls:
 *   LOG_LEVEL        debug|info|warn|error  (default: info)
 *   LOG_TIMESTAMPS   0|1                    (default: 0)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LABELS: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info:  'INFO ',
  warn:  'WARN ',
  error: 'ERROR',
};

function resolveLevel(): number {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

function useTimestamps(): boolean {
  return process.env['LOG_TIMESTAMPS'] === '1';
}

export function createLogger(prefix: string): Logger {
  function emit(level: LogLevel, args: unknown[]): void {
    if (LEVELS[level] < resolveLevel()) return;

    const tag = useTimestamps()
      ? `${new Date().toISOString()} ${LABELS[level]} [${prefix}]`
      : `${LABELS[level]} [${prefix}]`;

    const sink = level === 'error' ? console.error
                : level === 'warn'  ? console.warn
                : level === 'debug' ? console.debug
                : console.log;

    sink(tag, ...args);
  }

  return {
    debug: (...args) => emit('debug', args),
    info:  (...args) => emit('info',  args),
    warn:  (...args) => emit('warn',  args),
    error: (...args) => emit('error', args),
  };
}
