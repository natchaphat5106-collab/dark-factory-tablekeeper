/**
 * Unit 6 — structured JSON logging.
 *
 * One JSON object per line, with `time`, `level`, `message`, and a `context` object. The
 * logger never writes free-form text, so a log line is parseable by a machine and a
 * multi-line message cannot break the one-object-per-line framing.
 *
 * PII is redacted on the way out: context keys that name personal or credential fields
 * are replaced wholesale, and email-shaped substrings are scrubbed from string values.
 * The redaction set is a default, not a ceiling — callers can extend it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Record<string, unknown>;

export type Logger = {
  level: LogLevel;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
};

export type CreateLoggerOptions = {
  /** Minimum level that is written. Defaults to `info`. */
  level?: LogLevel;
  /** Context merged into every line. */
  context?: LogContext;
  /** Sink for a complete line, without a trailing newline. Defaults to stdout. */
  write?: (line: string) => void;
  /** Clock. Defaults to `new Date()`. */
  now?: () => Date | string;
  /** Extra context keys to redact, matched case-insensitively. */
  redact?: readonly string[];
};

const REDACTED = '[REDACTED]';
const REDACTED_EMAIL = '[REDACTED_EMAIL]';
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

const DEFAULT_REDACTED_KEYS: readonly string[] = [
  'authorization',
  'api_key',
  'apikey',
  'x-api-key',
  'cookie',
  'password',
  'secret',
  'token',
  'email',
  'phone',
  'phone_number',
  'full_name',
  'first_name',
  'last_name',
  'address',
  'ssn',
  'dob',
  'date_of_birth',
  'credit_card',
];

function scrubString(value: string): string {
  return value.replace(EMAIL_PATTERN, REDACTED_EMAIL);
}

function redactValue(value: unknown, keys: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keys));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      result[key] = keys.has(key.toLowerCase()) ? REDACTED : redactValue(inner, keys);
    }
    return result;
  }
  return value;
}

/**
 * Build a logger. `child` returns a logger that merges `context` under every line;
 * per-call context overrides the child, which overrides the parent.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  if (!(level in LOG_LEVELS)) {
    throw new TypeError(`unknown log level: ${String(level)}`);
  }
  const threshold = LOG_LEVELS[level];
  const baseContext = options.context ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const redactedKeys = new Set([
    ...DEFAULT_REDACTED_KEYS,
    ...(options.redact ?? []).map((key) => key.toLowerCase()),
  ]);

  const emit = (lineLevel: LogLevel, message: string, context?: LogContext): void => {
    if (LOG_LEVELS[lineLevel] < threshold) return;
    const instant = now();
    const time = instant instanceof Date ? instant.toISOString() : instant;
    const merged = redactValue({ ...baseContext, ...context }, redactedKeys) as Record<string, unknown>;
    write(JSON.stringify({ time, level: lineLevel, message: scrubString(String(message)), context: merged }));
  };

  return {
    level,
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (context) => createLogger({ level, context: { ...baseContext, ...context }, write, now, redact: [...redactedKeys] }),
  };
}
