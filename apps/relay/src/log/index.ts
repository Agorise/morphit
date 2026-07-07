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

/** Strip terminal-control bytes from a single string so it can't
 *  inject ANSI escapes into the operator's journal/console.  Mirror
 *  of apps/ops-cli/src/render/term.ts:sanitizeForTerm() but inline
 *  to avoid a cross-app import (relay log is the deepest dep root
 *  in the relay process).
 *
 *  cp139-E-1: a malicious operator-configurable value (RPC endpoint
 *  URL, persistPath, etc.) or a chain-RPC error message that contains
 *  control bytes would otherwise reach the operator's terminal via
 *  textSink's bare-string emission of values without spaces.  jsonSink
 *  is unaffected (JSON.stringify escapes control bytes natively).
 *
 *  Preserves: tab, newline, printable ASCII (0x20-0x7E except 0x7F),
 *  UTF-8 continuation bytes (>=0xA0).  Drops: C0/C1 control chars,
 *  DEL, non-SGR ESC sequences.  SGR escapes (ESC [ ... m) preserved
 *  in case a logger ever wants colored output (currently unused). */
function sanitizeForJournal(s: string): string {
	let out = '';
	let i = 0;
	while (i < s.length) {
		const ch = s.charCodeAt(i);
		if (ch === 0x1b) {
			// ESC: pass SGR sequences (ESC [ N;N;... m), drop everything else.
			if (s.charCodeAt(i + 1) === 0x5b) {
				let j = i + 2;
				let isSgr = false;
				const maxJ = Math.min(s.length, i + 32);
				while (j < maxJ) {
					const cc = s.charCodeAt(j);
					if (cc === 0x6d) {
						let allDigits = true;
						for (let k = i + 2; k < j; k++) {
							const c2 = s.charCodeAt(k);
							if (!((c2 >= 0x30 && c2 <= 0x39) || c2 === 0x3b)) {
								allDigits = false;
								break;
							}
						}
						if (allDigits) {
							out += s.slice(i, j + 1);
							i = j + 1;
							isSgr = true;
						}
						break;
					}
					if (!((cc >= 0x30 && cc <= 0x39) || cc === 0x3b)) break;
					j++;
				}
				if (isSgr) continue;
				i++;
				continue;
			}
			i++;
			continue;
		}
		if ((ch >= 0x00 && ch <= 0x08) || (ch >= 0x0b && ch <= 0x1f)) {
			i++;
			continue;
		}
		if (ch === 0x7f) {
			i++;
			continue;
		}
		if (ch >= 0x80 && ch <= 0x9f) {
			i++;
			continue;
		}
		out += s[i];
		i++;
	}
	return out;
}

/**
 * Human-friendly text sink. Matches the existing bracketed
 * convention (`[module] event ...`) that the codebase has used
 * since Phase 3, so migrating call sites doesn't change dev
 * output visually — what changes is that context fields are
 * appended in a machine-parseable form at the end.
 */
export const textSink: LogSink = (r) => {
	// cp139-E-1: sanitize module + event + each context value to
	// strip terminal-control escapes.  Defense-in-depth against
	// operator-configurable values (RPC URLs, file paths) that
	// reach context fields and would otherwise emit raw to the
	// journal/console via the bare-string path in formatValue().
	const parts: string[] = [`[${sanitizeForJournal(r.module)}]`, sanitizeForJournal(r.event)];
	const ctx = Object.entries(r.context);
	if (ctx.length > 0) {
		parts.push(ctx.map(([k, v]) => `${sanitizeForJournal(k)}=${formatValue(v)}`).join(' '));
	}
	const line = parts.join(' ');
	const stream = r.level === 'error' || r.level === 'warn' ? process.stderr : process.stdout;
	stream.write(line + '\n');
	if (r.error?.stack) {
		stream.write(sanitizeForJournal(r.error.stack) + '\n');
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
	if (typeof v === 'string') {
		// cp139-E-1: bare emission (no space) skips JSON.stringify
		// which would have escaped control bytes.  Sanitize so a
		// value like an operator-configured persistPath with embedded
		// ESC can't inject terminal-control escapes into the
		// journal.  JSON.stringify path already escapes control
		// bytes natively (\u001b form).
		const safe = sanitizeForJournal(v);
		return safe.includes(' ') ? JSON.stringify(safe) : safe;
	}
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
