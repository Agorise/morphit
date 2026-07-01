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
/** Strip terminal-control bytes from a single string so it can't
 *  inject ANSI escapes into the operator's journal/console.  Mirror
 *  of apps/relay/src/log/index.ts:sanitizeForJournal() and
 *  apps/ops-cli/src/render/term.ts:sanitizeForTerm().  Kept inline
 *  to avoid a cross-app import (this log module is the deepest dep
 *  root in the indexer process).
 *
 *  cp139-F-1: discovered while walking the relay log module
 *  (cp139-E-1) — same bug class.  textSink's bare-string path in
 *  formatValue (for context values without spaces) emits the raw
 *  string to stdout/stderr.  Operator-configurable values
 *  (persistPath, endpoint URLs) or chain-RPC error messages
 *  containing control bytes would otherwise inject terminal escapes
 *  into the journal/console.  jsonSink unaffected (JSON.stringify
 *  escapes control bytes natively).
 *
 *  Preserves: tab, newline, printable ASCII (0x20-0x7E except 0x7F),
 *  UTF-8 continuation bytes (>=0xA0), SGR escapes (ESC [ ... m).
 *  Drops: C0/C1 control chars, DEL, non-SGR ESC sequences. */
function sanitizeForJournal(s: string): string {
	let out = '';
	let i = 0;
	while (i < s.length) {
		const ch = s.charCodeAt(i);
		if (ch === 0x1b) {
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

export const textSink: LogSink = (r) => {
	// cp139-F-1: sanitize module + event + each context key to strip
	// terminal-control escapes from the bare-string emission path.
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
	if (typeof v === 'string') {
		// cp139-F-1: sanitize bare emission to strip terminal-control
		// escapes.  JSON.stringify path (when value has space) already
		// escapes them natively.
		const safe = sanitizeForJournal(v);
		return safe.includes(' ') ? JSON.stringify(safe) : safe;
	}
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
	// Objects and arrays go through JSON to stay on a single line.
	try {
		return JSON.stringify(v);
	} catch {
		return '[unserialisable]';
	}
}

/** Marker substituted for redacted secret values in log context. */
export const REDACTED_MARKER = '[REDACTED]';

/**
 * Whether a log-context key should have its value redacted.
 *
 * Triggered for keys whose name signals "this is a secret":
 *
 *   - Env-var style: `SOMETHING_KEY`, `SOMETHING_PASSWORD`,
 *     `SOMETHING_PASSPHRASE`, `SOMETHING_SECRET`, `SOMETHING_TOKEN`,
 *     `SOMETHING_WIF`, `SOMETHING_MNEMONIC`, `SOMETHING_SEED_PHRASE`.
 *   - Code-side camelCase: `somethingKey`, `somethingPassword`,
 *     and similar (must have a preceding lowercase letter to
 *     avoid matching unrelated words like "monkey").
 *   - Standalone secret-named keys: `wif`, `mnemonic`,
 *     `passphrase`, `password`, `secret`, `seed_phrase`.
 *
 * Public-identifier patterns (`public_key`, `pubkey`, `publicId`,
 * keys ending in `PublicKey`) are explicitly exempt — they're
 * public by name and exposing them in logs is intended.
 *
 * Closes the OPERATIONS.md §X redaction claim (was previously
 * documented but not implemented).
 */
export function isSecretContextKey(key: string): boolean {
	// Normalize: lowercase, drop separators.  `VAPID_PRIVATE_KEY`
	// and `vapidPrivateKey` both become `vapidprivatekey`, so the
	// same rule covers env-var and camelCase styles.
	const norm = key.toLowerCase().replace(/[_-]/g, '');

	// Public-identifier allow-list runs first.  Catches
	// `public_key`, `publicKey`, `PUBLIC_KEY`, `user_public_key`,
	// `VAPID_PUBLIC_KEY`, `publicId`, `pubkey`.
	if (norm.includes('publickey')) return false;
	if (norm === 'publicid' || norm.endsWith('publicid')) return false;
	if (norm === 'pubkey' || norm.endsWith('pubkey')) return false;

	// Compound-substring deny-list: tokens whose presence in the
	// normalized key unambiguously indicates a secret.  Caught
	// here rather than via word-tokenization because they're
	// commonly written as a single conceptual unit
	// (`apiKey` is one idea, not two words).
	const COMPOUND_SECRETS = [
		'privatekey',
		'privkey',
		'seedphrase',
		'apikey',
		'authtoken',
		'accesstoken',
		'sessiontoken',
		'bearertoken',
		'passphrase',
		'password',
		'mnemonic'
	];
	for (const c of COMPOUND_SECRETS) {
		if (norm.includes(c)) return true;
	}

	// Word-tokenize on case-boundaries + separators.  Then
	// flag the key as a secret if its LAST word is a known
	// secret-suffix token.  Last-word-only matching avoids
	// false positives like `keystore_status` (last word
	// `status`) or `keyCount` (last word `count`).
	const words = key
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/[_-]/g, ' ')
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) return false;
	const LAST_WORD_SECRETS = new Set([
		'key',
		'password',
		'passphrase',
		'secret',
		'token',
		'wif',
		'mnemonic',
		'seed'
	]);
	const lastWord = words[words.length - 1]!;
	if (LAST_WORD_SECRETS.has(lastWord)) return true;

	return false;
}

/**
 * Walk a context object and replace any value whose key matches
 * `isSecretContextKey` with the `[REDACTED]` marker.  Recurses
 * into nested plain objects; arrays are left untouched (their
 * indices aren't keys, so the pattern wouldn't fire anyway).
 *
 * Non-mutating: returns a new object so the caller's context
 * (which may still be referenced by tests or other code) is
 * preserved.
 */
export function redactSecrets(
	ctx: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(ctx)) {
		if (isSecretContextKey(k)) {
			out[k] = REDACTED_MARKER;
		} else if (
			v &&
			typeof v === 'object' &&
			!Array.isArray(v) &&
			Object.getPrototypeOf(v) === Object.prototype
		) {
			// Recurse into plain objects only.  Class instances,
			// Date, Buffer, etc. pass through unchanged.
			out[k] = redactSecrets(v as Record<string, unknown>);
		} else {
			out[k] = v;
		}
	}
	return out;
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
		// Redact secret-named context values before they hit any
		// sink.  See `isSecretContextKey` for the pattern list and
		// rationale.  Documented in OPERATIONS.md §35 secret-
		// handling guidance.
		context: redactSecrets(context),
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
