/**
 * A chain call abandoned because its abort signal had already fired must not
 * become an unhandled rejection.
 *
 * 2026-10-08, morphit.io: the relay crashed five times in six minutes on
 * "unhandled_rejection AbortError: This operation was aborted" (it exits on an
 * unhandled rejection, by design, so systemd restarts it). `withSignal(call,
 * signal)` receives a call that has already been started; with the signal
 * already aborted it returned a rejection at once and left that call without a
 * handler, so the call's own failure, a minute later, was unhandled. The RPC
 * pool handed such signals out: a hedge sent after the race was already won
 * (packages/rpc-pool), and a quorum operator cancelled between two calls.
 */
import { describe, expect, it } from 'vitest';
import { withSignal } from '../src/blurt/client.ts';

const settle = async (): Promise<void> => {
	for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

describe('a call abandoned because its signal was already aborted', () => {
	it('its later failure is not an unhandled rejection', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (r: unknown): void => void unhandled.push(r);
		process.on('unhandledRejection', onUnhandled);
		try {
			const ctl = new AbortController();
			ctl.abort();
			let fail!: (e: Error) => void;
			const call = new Promise<never>((_, reject) => {
				fail = reject;
			});
			await expect(withSignal(call, ctl.signal)).rejects.toThrow('aborted');
			fail(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
			await settle();
			expect(unhandled, 'the abandoned call failed unhandled').toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('a call whose signal aborts while it runs is still handed back as aborted', async () => {
		const ctl = new AbortController();
		let fail!: (e: Error) => void;
		const call = new Promise<never>((_, reject) => {
			fail = reject;
		});
		const p = withSignal(call, ctl.signal);
		ctl.abort();
		await expect(p).rejects.toThrow('aborted');
		fail(new Error('late'));
		await settle();
	});
});
