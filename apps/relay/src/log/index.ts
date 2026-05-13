/**
 * Morphit relay — structured logger.
 *
 * A tiny structured logger with two sinks: human-readable text
 * (for dev, matching the existing `[module] event ...` convention)
 * and JSON-line (for prod, grep + log-aggregator friendly). The
 * sink is swappable at runtime via `setLogSink()` for tests.
 *
 * Mirrors the indexer's `$log` module — both apps share the same
 * logging contract so operators reading one app's output know
 * what to expect from the other. The duplication is deliberate:
 * keeping the two apps' internals independent avoids pulling
 * one through the other's dependency graph.
 *
 * Usage:
 *
 *   import { logger } from '$log';
 *   const log = logger('drainer');
 *   log.info('transfer_broadcast', { kind, recipient, amount_blurt });
 *   log.error('rpc_failed', { endpoint }, err);
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
 * JSON-line sink for production. One record per line.
 */
export const jsonSink: LogSink = (r) => {
	const stream = r.level === 'error' || r.level === 'warn' ? process.stderr : process.stdout;
	stream.write(JSON.stringify(r) + '\n');
};

function formatValue(v: unknown): string {
	if (v === null) return 'null';
	if (v === undefined) return 'undefined';
	if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
	try {
		return JSON.stringify(v);
	} catch {
		return '[unserialisable]';
	}
}

let activeSink: LogSink = pickDefaultSink();
let minLevel: LogLevel = (process.env.MORPHIT_LOG_LEVEL as LogLevel) ?? 'info';

function pickDefaultSink(): LogSink {
	const fmt = (process.env.MORPHIT_LOG_FORMAT ?? '').toLowerCase();
	if (fmt === 'json') return jsonSink;
	if (fmt === 'text') return textSink;
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

export interface Logger {
	debug(event: string, context?: Record<string, unknown>): void;
	info(event: string, context?: Record<string, unknown>): void;
	warn(event: string, context?: Record<string, unknown>, error?: unknown): void;
	error(event: string, context?: Record<string, unknown>, error?: unknown): void;
}

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
