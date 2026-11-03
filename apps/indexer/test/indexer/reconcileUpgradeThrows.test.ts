/**
 * v1.22.0 — how the upgrade replay classifies a throw (reconcileUpgrade.ts).
 *
 * A handler that throws is recorded as the live dispatcher records it
 * ('handler_threw:<message>', whatever it threw), unless it threw on a passing
 * database trouble; a statement after a handler that returned ok on an aborted
 * transaction fails 25P02, recorded 'handler_aborted_tx' as the dispatcher's
 * failed RELEASE is. Anything else undoes the heal for the next boot. A
 * PostgreSQL error is judged by its SQLSTATE only: its message may quote the
 * op's own text, and a deterministic error whose message happened to say
 * "timeout" would otherwise be retried at every boot.
 */
import { describe, expect, it } from 'vitest';
import { HandlerThrew, isPassingDbTrouble, liveReasonForThrow } from '$indexer/reconcileUpgrade';

const pgError = (code: string, message = 'x') => Object.assign(new Error(message), { code });

describe('isPassingDbTrouble', () => {
	it.each([
		['08006', 'connection failure'],
		['57P01', 'admin shutdown'],
		['57014', 'statement timeout'],
		['40001', 'serialization failure'],
		['40P01', 'deadlock'],
		['55P03', 'lock not available'],
		['55006', 'object in use'],
		['53300', 'too many connections'],
		['58030', 'I/O error']
	])('%s (%s) passes by itself', (code) => {
		expect(isPassingDbTrouble(pgError(code))).toBe(true);
	});

	it.each([
		['23505', 'unique violation'],
		['22P02', 'invalid text representation'],
		['42P01', 'undefined table']
	])('%s (%s) does not', (code) => {
		expect(isPassingDbTrouble(pgError(code))).toBe(false);
	});

	it('judges a PostgreSQL error by its SQLSTATE, not by a message quoting user text', () => {
		expect(isPassingDbTrouble(pgError('22P02', 'invalid input syntax: "statement timeout"'))).toBe(
			false
		);
	});

	it('reads the message only for an error without a SQLSTATE (the driver)', () => {
		expect(isPassingDbTrouble(new Error('Connection terminated unexpectedly'))).toBe(true);
		expect(isPassingDbTrouble(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(true);
		expect(isPassingDbTrouble(new Error('boom'))).toBe(false);
		expect(isPassingDbTrouble('nothing')).toBe(false);
		// what pg throws for every query after the connection broke
		expect(
			isPassingDbTrouble(
				new Error('Client has encountered a connection error and is not queryable')
			)
		).toBe(true);
	});

	it('reads a Node.js system error code as one (a lost socket), not as a SQLSTATE', () => {
		for (const code of [
			'EPIPE',
			'ECONNRESET',
			'ETIMEDOUT',
			'EHOSTUNREACH',
			'EHOSTDOWN',
			'ENOTCONN',
			'ERR_SOCKET_CLOSED',
			'ERR_STREAM_DESTROYED'
		])
			expect(isPassingDbTrouble(pgError(code))).toBe(true);
		// a programming error is not passing (and its message is read)
		expect(isPassingDbTrouble(pgError('ERR_INVALID_ARG_TYPE', 'bad arg'))).toBe(false);
		expect(isPassingDbTrouble(pgError('ERR_SOMETHING', 'Connection terminated'))).toBe(true);
	});
});

describe('liveReasonForThrow', () => {
	it('a handler that throws: handler_threw:<message>, as the dispatcher records it', () => {
		expect(liveReasonForThrow(new HandlerThrew(new Error('boom')))).toBe('handler_threw:boom');
		expect(liveReasonForThrow(new HandlerThrew('weird'))).toBe('handler_threw');
		expect(liveReasonForThrow(new HandlerThrew(new Error('y'.repeat(300))))).toBe(
			`handler_threw:${'y'.repeat(120)}`
		);
		// the dispatcher records a handler that THROWS on an aborted transaction
		// as handler_threw, not handler_aborted_tx
		expect(
			liveReasonForThrow(new HandlerThrew(pgError('25P02', 'current transaction is aborted')))
		).toBe('handler_threw:current transaction is aborted');
	});

	it('a statement after a handler that returned ok on an aborted transaction: handler_aborted_tx', () => {
		expect(liveReasonForThrow(pgError('25P02', 'current transaction is aborted'))).toBe(
			'handler_aborted_tx'
		);
	});

	it('not the op’s fault: null (the heal is undone for the next boot)', () => {
		expect(liveReasonForThrow(new HandlerThrew(pgError('57014')))).toBeNull();
		expect(
			liveReasonForThrow(new HandlerThrew(new Error('Connection terminated unexpectedly')))
		).toBeNull();
		// outside a handler: a failed savepoint rollback on a broken connection
		expect(
			liveReasonForThrow(
				new Error('Client has encountered a connection error and is not queryable')
			)
		).toBeNull();
		expect(liveReasonForThrow(new Error('boom'))).toBeNull();
	});
});
