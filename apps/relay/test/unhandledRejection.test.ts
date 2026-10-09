/**
 * The relay keeps running when an abandoned request to a Blurt node ends
 * (2026-10-08, morphit.io: twelve restarts over "AbortError" and "TypeError:
 * fetch failed"), and still stops on any other unhandled rejection.
 */
import { describe, it, expect } from 'vitest';
import { onUnhandledRejection } from '../src/lib/unhandledRejection.ts';

function run(reason: unknown): { exited: number | null; warned: string[]; errored: string[] } {
	const out = { exited: null as number | null, warned: [] as string[], errored: [] as string[] };
	onUnhandledRejection(reason, {
		warn: (e) => void out.warned.push(e),
		error: (e) => void out.errored.push(e),
		exit: (c) => void (out.exited = c)
	});
	return out;
}

const abortError = (): Error => {
	const c = new AbortController();
	c.abort();
	return c.signal.reason as Error;
};

describe('an unhandled rejection in the relay', () => {
	it('a cancelled node request is logged and the relay keeps running', () => {
		const r = run(abortError());
		expect(r.exited).toBeNull();
		expect(r.warned).toEqual(['unhandled_network_rejection']);
	});

	it('a failed connection to a node ("fetch failed") is logged and the relay keeps running', async () => {
		const err = await fetch('http://127.0.0.1:1/').catch((e: unknown) => e);
		const r = run(err);
		expect(r.exited).toBeNull();
		expect(r.warned).toHaveLength(1);
	});

	it('anything else still stops the relay', () => {
		for (const reason of [
			new Error('fetch failed'), // not the fetch's own TypeError
			new TypeError('Cannot read properties of undefined'),
			new RangeError('x'),
			'aborted',
			undefined
		]) {
			const r = run(reason);
			expect(r.exited, String(reason)).toBe(1);
			expect(r.errored).toEqual(['unhandled_rejection']);
		}
	});
});
