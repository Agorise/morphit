/**
 * prefetch-in-order-smoke (cp664) — guards the delicate ordering + resilience
 * guarantees of `consumeInOrderWithPrefetch`, the core of the indexer's
 * concurrent catch-up backfill. A subtle bug here would let the poller apply
 * blocks OUT OF ORDER or skip one — corrupting the index — so these run with a
 * deterministic, real-wall-clock mock (short ≤200 ms timeouts).
 *
 * Proven behaviours:
 *   1. IN-ORDER despite OUT-OF-ORDER completion — a slow early fetch still
 *      blocks its later, already-finished siblings; values arrive in START
 *      order, never completion order.
 *   2. CONCURRENCY BOUND — never more than `concurrency` fetches are in flight.
 *   3. EARLY-STOP ABANDONMENT — returning false stops consumption and abandons
 *      in-flight fetches; an abandoned fetch that later REJECTS does NOT surface
 *      as an unhandled rejection.
 *   4. FETCH-REJECTION PROPAGATION — a rejecting fetch that reaches consumption
 *      re-throws out of the helper (so the poller's try/catch can back off),
 *      and every value before it was delivered in order.
 */

import { consumeInOrderWithPrefetch } from '../src/indexer/prefetch.ts';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
const pass = (name: string) => results.push({ name, passed: true });
const fail = (name: string, detail: string) => results.push({ name, passed: false, detail });

const delay = <T>(value: T, ms: number): Promise<T> =>
	new Promise((res) => setTimeout(() => res(value), ms));
const reject = (msg: string, ms: number): Promise<never> =>
	new Promise((_res, rej) => setTimeout(() => rej(new Error(msg)), ms));
const eq = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

async function main(): Promise<void> {
	/* ---- 1. in-order despite out-of-order completion ---- */
	{
		const total = 5;
		let started = 0;
		const delivered: number[] = [];
		await consumeInOrderWithPrefetch<number>(
			3,
			() => {
				if (started >= total) return null;
				const idx = started++;
				// idx 0 is SLOWEST (150 ms), idx 4 fastest (30 ms) — so within the
				// first primed batch, later indices resolve first.
				return delay(idx, (total - idx) * 30);
			},
			(v) => {
				delivered.push(v);
			}
		);
		if (eq(delivered, [0, 1, 2, 3, 4])) {
			pass('in-order delivery despite out-of-order fetch completion');
		} else {
			fail('in-order delivery despite out-of-order fetch completion', `got [${delivered.join(',')}]`);
		}
	}

	/* ---- 2. concurrency bound ---- */
	{
		const total = 12;
		const concurrency = 4;
		let started = 0;
		let outstanding = 0;
		let peak = 0;
		await consumeInOrderWithPrefetch<number>(
			concurrency,
			() => {
				if (started >= total) return null;
				const idx = started++;
				outstanding++;
				peak = Math.max(peak, outstanding);
				return new Promise<number>((res) =>
					setTimeout(() => {
						outstanding--;
						res(idx);
					}, 15)
				);
			},
			() => {}
		);
		if (peak <= concurrency && peak === concurrency) {
			pass(`concurrency bound respected (peak ${peak} === limit ${concurrency}, never exceeded)`);
		} else {
			fail('concurrency bound respected', `peak=${peak}, limit=${concurrency}`);
		}
	}

	/* ---- 3. early-stop abandonment: abandoned rejection is not unhandled ---- */
	{
		let sawUnhandled: string | null = null;
		const onUnhandled = (err: unknown) => {
			sawUnhandled = err instanceof Error ? err.message : String(err);
		};
		process.on('unhandledRejection', onUnhandled);

		let started = 0;
		const delivered: number[] = [];
		await consumeInOrderWithPrefetch<number>(
			3,
			() => {
				if (started >= 6) return null;
				const idx = started++;
				// idx 2 is primed + in flight, and REJECTS at 40 ms — AFTER we've
				// stopped (we stop right after delivering idx 0 and 1). It must be
				// swallowed by the helper's abandoned-safety catch.
				if (idx === 2) return reject('abandoned-boom', 40);
				return delay(idx, 15);
			},
			(v) => {
				delivered.push(v);
				return delivered.length < 2 ? undefined : false; // stop after 2
			}
		);

		// Give the abandoned idx-2 rejection time to fire.
		await delay(0, 80);
		process.off('unhandledRejection', onUnhandled);

		if (eq(delivered, [0, 1]) && sawUnhandled === null) {
			pass('early stop abandons in-flight fetches with NO unhandled rejection');
		} else {
			fail(
				'early stop abandons in-flight fetches with NO unhandled rejection',
				`delivered=[${delivered.join(',')}], unhandled=${sawUnhandled ?? 'none'}`
			);
		}
	}

	/* ---- 4. fetch-rejection propagation (consumed, not abandoned) ---- */
	{
		let sawUnhandled = false;
		const onUnhandled = () => {
			sawUnhandled = true;
		};
		process.on('unhandledRejection', onUnhandled);

		let started = 0;
		const delivered: number[] = [];
		let caught: Error | null = null;
		try {
			await consumeInOrderWithPrefetch<number>(
				2,
				() => {
					if (started >= 5) return null;
					const idx = started++;
					if (idx === 2) return reject('consumed-boom', 15);
					return delay(idx, 15);
				},
				(v) => {
					delivered.push(v);
				}
			);
		} catch (err) {
			caught = err instanceof Error ? err : new Error(String(err));
		}

		await delay(0, 40);
		process.off('unhandledRejection', onUnhandled);

		if (caught?.message === 'consumed-boom' && eq(delivered, [0, 1]) && !sawUnhandled) {
			pass('a consumed fetch rejection propagates out (values before it delivered in order)');
		} else {
			fail(
				'a consumed fetch rejection propagates out',
				`caught=${caught?.message ?? 'none'}, delivered=[${delivered.join(',')}], unhandled=${sawUnhandled}`
			);
		}
	}

	/* ---------------- report ---------------- */
	let failed = 0;
	for (const r of results) {
		if (r.passed) {
			console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
		} else {
			console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
			if (r.detail) console.log('      ' + r.detail);
			failed++;
		}
	}
	console.log();
	console.log('──────────────────────────────────────────────────────');
	if (failed > 0) {
		console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
		process.exit(1);
	} else {
		console.log('✓ all ' + results.length + ' prefetch-in-order scenarios passed');
	}
}

void main();
