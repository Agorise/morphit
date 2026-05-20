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
import { logger, setLogSink, setLogLevel, type LogRecord, type LogSink } from '$log';

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
