/**
 * Logger unit tests.
 *
 * Focus: the logger's contract to callers (level filtering,
 * module scoping, error shape preservation) and to sinks
 * (record shape stability across dev and prod). Does NOT test
 * the default sinks' exact output format byte-for-byte —
 * that's output shape which is allowed to evolve without
 * rewriting the tests.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { logger, setLogSink, setLogLevel, REDACTED_MARKER, type LogRecord, type LogSink } from '$log';

describe('logger', () => {
	let captured: LogRecord[];
	let restore: () => void;

	beforeEach(() => {
		captured = [];
		const sink: LogSink = (r) => captured.push(r);
		restore = setLogSink(sink);
		// Reset to info for each test; tests that need debug can raise.
		setLogLevel('info');
		return () => restore();
	});

	it('emits records with module and event', () => {
		const log = logger('test.module');
		log.info('some_event', { foo: 'bar' });

		expect(captured).toHaveLength(1);
		const record = captured[0]!;
		expect(record.module).toBe('test.module');
		expect(record.event).toBe('some_event');
		expect(record.context).toEqual({ foo: 'bar' });
		expect(record.level).toBe('info');
	});

	it('emits an ISO timestamp', () => {
		const log = logger('t');
		log.info('e');
		const ts = captured[0]!.ts;
		// 2026-04-20T12:34:56.789Z — parseable as a valid date
		expect(Number.isNaN(Date.parse(ts))).toBe(false);
	});

	it('defaults context to an empty object', () => {
		const log = logger('t');
		log.info('e');
		expect(captured[0]!.context).toEqual({});
	});

	it('filters by level', () => {
		setLogLevel('warn');
		const log = logger('t');
		log.debug('d');
		log.info('i');
		log.warn('w');
		log.error('e');
		expect(captured.map((r) => r.event)).toEqual(['w', 'e']);
	});

	it('captures Error instances with name, message, and stack', () => {
		const log = logger('t');
		const err = new TypeError('bad stuff');
		log.error('op_failed', { op: 'x' }, err);

		const record = captured[0]!;
		expect(record.error).toBeDefined();
		expect(record.error?.name).toBe('TypeError');
		expect(record.error?.message).toBe('bad stuff');
		expect(typeof record.error?.stack).toBe('string');
		expect(record.error?.stack).toContain('TypeError');
	});

	it('captures non-Error thrown values as UnknownError', () => {
		const log = logger('t');
		log.error('op_failed', {}, 'string thrown from old code');
		expect(captured[0]!.error?.name).toBe('UnknownError');
		expect(captured[0]!.error?.message).toBe('string thrown from old code');
	});

	it('omits the error field when none given', () => {
		const log = logger('t');
		log.warn('heads_up', { reason: 'rate_limit_near' });
		expect(captured[0]!.error).toBeUndefined();
	});

	it('setLogSink returns a restore function', () => {
		const first: LogRecord[] = [];
		const second: LogRecord[] = [];

		const restoreFirst = setLogSink((r) => first.push(r));
		logger('t').info('event_one');
		const restoreSecond = setLogSink((r) => second.push(r));
		logger('t').info('event_two');
		restoreSecond();
		logger('t').info('event_three');
		restoreFirst();

		expect(first.map((r) => r.event)).toEqual(['event_one', 'event_three']);
		expect(second.map((r) => r.event)).toEqual(['event_two']);
	});

	it('setLogLevel returns the previous level', () => {
		setLogLevel('info');
		const previous = setLogLevel('error');
		expect(previous).toBe('info');
	});

	it('supports debug level when enabled', () => {
		setLogLevel('debug');
		const log = logger('t');
		log.debug('detailed', { n: 42 });
		expect(captured).toHaveLength(1);
		expect(captured[0]!.level).toBe('debug');
	});

	it('handles bigint context values without throwing', () => {
		const log = logger('t');
		log.info('chain_state', { block: 1234567890n });
		expect(captured[0]!.context.block).toBe(1234567890n);
	});
});

describe('jsonSink', () => {
	it('serializes bigint context values as strings without throwing (cp70-D7)', async () => {
		const { jsonSink } = await import('$log');
		const stream = process.stdout;
		const lines: string[] = [];
		const originalWrite = stream.write;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		stream.write = ((chunk: string | Buffer): boolean => {
			lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
			return true;
		}) as typeof stream.write;
		try {
			jsonSink({
				ts: '2026-05-20T00:00:00.000Z',
				level: 'info',
				module: 't',
				event: 'fee_verified',
				context: { amount_piconero: 781250000000n, count: 5 }
			});
		} finally {
			stream.write = originalWrite;
		}
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.context.amount_piconero).toBe('781250000000');
		expect(parsed.context.count).toBe(5);
	});

	it('survives unserialisable values (cyclic refs) without crashing the host', async () => {
		const { jsonSink } = await import('$log');
		const stream = process.stderr;
		const lines: string[] = [];
		const originalWrite = stream.write;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		stream.write = ((chunk: string | Buffer): boolean => {
			lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
			return true;
		}) as typeof stream.write;
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		try {
			jsonSink({
				ts: '2026-05-20T00:00:00.000Z',
				level: 'error',
				module: 't',
				event: 'something',
				context: cyclic
			});
		} finally {
			stream.write = originalWrite;
		}
		expect(lines).toHaveLength(1);
		// The fallback degraded line is a valid JSON object with a
		// 'log_serialization_failed' message.  The aggregator keeps
		// parsing the stream.
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.msg).toBe('log_serialization_failed');
	});
});

describe('secret redaction (cp84-O31)', () => {
	let captured: LogRecord[];
	let restore: () => void;

	beforeEach(() => {
		captured = [];
		const sink: LogSink = (r) => captured.push(r);
		restore = setLogSink(sink);
		setLogLevel('info');
		return () => restore();
	});

	it('redacts env-var-style secret keys (*_KEY, *_PASSWORD, etc.)', () => {
		const log = logger('test');
		log.info('event', {
			VAPID_PRIVATE_KEY: 'should-be-redacted',
			MORPHIT_RELAY_ACTIVE_KEY: 'should-be-redacted',
			POSTGRES_PASSWORD: 'should-be-redacted',
			SOME_TOKEN: 'should-be-redacted',
			SOMETHING_SECRET: 'should-be-redacted'
		});
		const ctx = captured[0]!.context;
		expect(ctx.VAPID_PRIVATE_KEY).toBe(REDACTED_MARKER);
		expect(ctx.MORPHIT_RELAY_ACTIVE_KEY).toBe(REDACTED_MARKER);
		expect(ctx.POSTGRES_PASSWORD).toBe(REDACTED_MARKER);
		expect(ctx.SOME_TOKEN).toBe(REDACTED_MARKER);
		expect(ctx.SOMETHING_SECRET).toBe(REDACTED_MARKER);
	});

	it('redacts camelCase secret-suffixed keys', () => {
		const log = logger('test');
		log.info('event', {
			activeKey: 'redact-me',
			postingKey: 'redact-me',
			apiKey: 'redact-me',
			userPassword: 'redact-me',
			authToken: 'redact-me'
		});
		const ctx = captured[0]!.context;
		expect(ctx.activeKey).toBe(REDACTED_MARKER);
		expect(ctx.postingKey).toBe(REDACTED_MARKER);
		expect(ctx.apiKey).toBe(REDACTED_MARKER);
		expect(ctx.userPassword).toBe(REDACTED_MARKER);
		expect(ctx.authToken).toBe(REDACTED_MARKER);
	});

	it('redacts standalone secret-named keys', () => {
		const log = logger('test');
		log.info('event', { wif: 'x', mnemonic: 'y', password: 'z', secret: 'w' });
		const ctx = captured[0]!.context;
		expect(ctx.wif).toBe(REDACTED_MARKER);
		expect(ctx.mnemonic).toBe(REDACTED_MARKER);
		expect(ctx.password).toBe(REDACTED_MARKER);
		expect(ctx.secret).toBe(REDACTED_MARKER);
	});

	it('does NOT redact public-identifier keys', () => {
		const log = logger('test');
		log.info('event', {
			VAPID_PUBLIC_KEY: 'BLT-pubkey-not-secret',
			publicKey: 'BLT-pubkey',
			pubkey: 'BLT-pubkey',
			publicId: 'session-12345',
			user_public_key: 'BLT-pubkey'
		});
		const ctx = captured[0]!.context;
		expect(ctx.VAPID_PUBLIC_KEY).toBe('BLT-pubkey-not-secret');
		expect(ctx.publicKey).toBe('BLT-pubkey');
		expect(ctx.pubkey).toBe('BLT-pubkey');
		expect(ctx.publicId).toBe('session-12345');
		expect(ctx.user_public_key).toBe('BLT-pubkey');
	});

	it('does NOT redact innocent words that contain Key/key substrings', () => {
		const log = logger('test');
		log.info('event', {
			monkey: 'innocent',
			donkey: 'innocent',
			keystore_status: 'ok' // contains "key" but as a noun, not as a suffix
		});
		const ctx = captured[0]!.context;
		expect(ctx.monkey).toBe('innocent');
		expect(ctx.donkey).toBe('innocent');
		expect(ctx.keystore_status).toBe('ok');
	});

	it('recurses into nested plain objects', () => {
		const log = logger('test');
		log.info('event', {
			outer: {
				safeField: 'ok',
				activeKey: 'redact-me-too',
				nested: { POSTGRES_PASSWORD: 'redact-deep' }
			}
		});
		const ctx = captured[0]!.context as Record<string, Record<string, unknown>>;
		expect(ctx.outer!.safeField).toBe('ok');
		expect(ctx.outer!.activeKey).toBe(REDACTED_MARKER);
		expect((ctx.outer!.nested as Record<string, unknown>).POSTGRES_PASSWORD).toBe(REDACTED_MARKER);
	});

	it('does not mutate the original context object', () => {
		const log = logger('test');
		const ctx = { activeKey: 'still-here-after-log' };
		log.info('event', ctx);
		expect(ctx.activeKey).toBe('still-here-after-log');
		expect(captured[0]!.context.activeKey).toBe(REDACTED_MARKER);
	});
});
