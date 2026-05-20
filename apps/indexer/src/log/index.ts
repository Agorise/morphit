/**
 * Morphit indexer — structured logger.
 *
 * A tiny structured logger with two sinks: human-readable text
 * (for dev, matching the existing `[module] event ...` convention)
 * and JSON-line (for prod, grep + log-aggregator friendly). The
 * sink is swappable at runtime via `setLogSink()` for tests.
 *
 * No external dependencies. Pino, winston, and bunyan all solve
 * problems we don't have; their features (log rotation, transports,
 * async flushing) are orthogonal to what we need here. Keeping it
 * homegrown means we ship fewer lines, audit fewer upstream CVEs,
 * and the logger is trivial to understand.
 *
 * Usage:
 *
 *   import { logger } from '$log';
 *   const log = logger('order.handler');
 *   log.info('fee_verified', { signer, permlink, amount_blurt });
 *   log.warn('explorer_down', { provider: 'btc', error: err.message });
 *   log.error('db_write_failed', { table: 'orders' }, err);
 *
 * The second argument is the structured context — always an object,
 * never a free string — so log search + metric extraction work
 * identically in dev and prod.
 */

/** Log levels, ordered by severity. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

/** Structured log record. Sinks receive this shape. */
export interface LogRecord {
	readonly ts: string;
	readonly level: LogLevel;
	readonly module: string;
	readonly event: string;
	readonly context: Record<string, unknown>;
	readonly error?: {
		readonly name: string;
		readonly message: string;
		readonly stack?: string;
	};
}

/** A sink is what turns records into output. */
export type LogSink = (record: LogRecord) => void;

/**
 * Human-friendly text sink. Matches the existing bracketed
 * convention (`[module] event ...`) that the codebase has used
 * since Phase 3, so migrating call sites doesn't change dev
 * output visually — what changes is that context fields are
 * appended in a machine-parseable form at the end.
 */
export const textSink: LogSink = (r) => {
	const parts: string[] = [`[${r.module}]`, r.event];
	const ctx = Object.entries(r.context);
	if (ctx.length > 0) {
		parts.push(ctx.map(([k, v]) => `${k}=${formatValue(v)}`).join(' '));
	}
	const line = parts.join(' ');
	const stream = r.level === 'error' || r.level === 'warn' ? process.stderr : process.stdout;
	stream.write(line + '\n');
	if (r.error?.stack) {
		stream.write(r.error.stack + '\n');
	}
};

/**
 * JSON-line sink for production. One record per line. Every
 * record has the same shape, so log aggregators (loki, vector,
 * etc.) can parse without any pattern config.
 *
 * BigInt safety: JSON.stringify throws on BigInt values by
 * default ("TypeError: Do not know how to serialize a BigInt").
 * The indexer has bigint fields (xmrFeePiconero, monero amounts)
 * and downstream code is generally careful to .toString() before
 * logging — but defense-in-depth: a future caller forgetting that
 * shouldn't crash a request handler.  We use a replacer that
 * stringifies any BigInt it encounters.
 *
 * cp70-D7: previously this throw was unguarded; a single
 * `log.info('foo', { amount: someBigint })` would crash the
 * handler that called it.  No production crashes observed
 * (everyone happens to .toString() at the call site), but the
 * latent fault is real.
 */
function bigintSafeReplacer(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? value.toString() : value;
}

export const jsonSink: LogSink = (r) => {
	const stream = r.level === 'error' || r.level === 'warn' ? process.stderr : process.stdout;
	try {
		stream.write(JSON.stringify(r, bigintSafeReplacer) + '\n');
	} catch (err) {
		// Last-resort fallback so a log-serialization failure
		// (cyclic refs, exotic objects) doesn't crash the host.
		// Write a degraded but valid JSON line so the aggregator
		// keeps parsing the stream.
		stream.write(
			JSON.stringify({
				ts: r.ts,
				level: 'error',
				msg: 'log_serialization_failed',
				err: String((err as Error)?.message ?? err)
			}) + '\n'
		);
	}
};

/** Format a context value for the text sink. */
function formatValue(v: unknown): string {
	if (v === null) return 'null';
	if (v === undefined) return 'undefined';
	if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
	// Objects and arrays go through JSON to stay on a single line.
	try {
		return JSON.stringify(v);
	} catch {
		return '[unserialisable]';
	}
}

/** Module-level sink; swap via setLogSink() in tests or on boot. */
let activeSink: LogSink = pickDefaultSink();
let minLevel: LogLevel = (process.env.MORPHIT_LOG_LEVEL as LogLevel) ?? 'info';

function pickDefaultSink(): LogSink {
	const fmt = (process.env.MORPHIT_LOG_FORMAT ?? '').toLowerCase();
	if (fmt === 'json') return jsonSink;
	if (fmt === 'text') return textSink;
	// Auto-pick: JSON in production, text otherwise. NODE_ENV isn't
	// strictly set everywhere but when it is, "production" is the
	// signal we want.
	return process.env.NODE_ENV === 'production' ? jsonSink : textSink;
}

/** Replace the sink. Returns a function that restores the previous
 *  sink — convenient for test cleanup. */
export function setLogSink(sink: LogSink): () => void {
	const previous = activeSink;
	activeSink = sink;
	return () => {
		activeSink = previous;
	};
}

/** Change the minimum level at runtime. Returns the previous level. */
export function setLogLevel(level: LogLevel): LogLevel {
	const previous = minLevel;
	minLevel = level;
	return previous;
}

/** A module-scoped logger. All log lines emitted through this
 *  object carry the given module name, so downstream consumers
 *  can filter / group without parsing event strings. */
export interface Logger {
	debug(event: string, context?: Record<string, unknown>): void;
	info(event: string, context?: Record<string, unknown>): void;
	warn(event: string, context?: Record<string, unknown>, error?: unknown): void;
	error(event: string, context?: Record<string, unknown>, error?: unknown): void;
}

/** Create a module-scoped logger. */
export function logger(module: string): Logger {
	return {
		debug: (event, context) => emit('debug', module, event, context),
		info: (event, context) => emit('info', module, event, context),
		warn: (event, context, err) => emit('warn', module, event, context, err),
		error: (event, context, err) => emit('error', module, event, context, err)
	};
}

function emit(
	level: LogLevel,
	module: string,
	event: string,
	context: Record<string, unknown> = {},
	maybeError?: unknown
): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
	const record: LogRecord = {
		ts: new Date().toISOString(),
		level,
		module,
		event,
		context,
		error: toErrorShape(maybeError)
	};
	activeSink(record);
}

function toErrorShape(e: unknown): LogRecord['error'] {
	if (!e) return undefined;
	if (e instanceof Error) {
		return { name: e.name, message: e.message, stack: e.stack };
	}
	return { name: 'UnknownError', message: String(e) };
}
