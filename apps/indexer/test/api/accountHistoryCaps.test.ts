/**
 * VT5-2 (route side) — /v1/account/:account/history cannot drive the indexer
 * to gigabytes of memory, or the RPC pool to gigabytes of downloads.
 *
 * A 10,000-entry page may be ~35 MiB from the node and ~130 MiB in this
 * process while it is parsed and re-serialised. Nothing limited how many ran
 * at once, and each was hedged (asked of two nodes) and retried: twelve at once
 * took the process past 2 GB. Now:
 *   - the entries in flight are capped instance-wide, per client, and for the
 *     shared key (every Tor/I2P visitor) together; a request over a cap is
 *     answered 503 `history_busy` with Retry-After, before any RPC call;
 *   - a page over 1,000 entries is never hedged;
 *   - the default page is 1,000 entries.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
	accountHistoryRoute,
	HISTORY_ENTRIES_GLOBAL,
	HISTORY_ENTRIES_PER_CLIENT
} from '$api/accountHistory';
import type { BlurtClient } from '$blurt/client';

interface Call {
	params: readonly unknown[];
	opts: { userFacing?: boolean } | undefined;
	finish: () => void;
}

/** A chain that holds every history read open until the test lets it go. */
function heldChain(): { blurt: BlurtClient; calls: Call[] } {
	const calls: Call[] = [];
	const blurt = {
		callCondenser: (_m: string, params: readonly unknown[], opts?: { userFacing?: boolean }) =>
			new Promise((resolve) => {
				calls.push({ params, opts, finish: () => resolve([]) });
			})
	} as unknown as BlurtClient;
	return { blurt, calls };
}

/** A request as it arrives from `ip` (the socket peer the limiter keys on). */
const from = (app: Hono, ip: string | null, query: string) =>
	app.request(
		`/v1/account/alice/history${query}`,
		{},
		ip === null ? undefined : { incoming: { socket: { remoteAddress: ip } } }
	);

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('account history: bounded memory and upstream load (VT5-2)', () => {
	let open: Call[] = [];
	afterEach(async () => {
		for (const c of open) c.finish();
		open = [];
		await tick();
	});

	it('caps the entries in flight per client and instance-wide, before any RPC call', async () => {
		expect(HISTORY_ENTRIES_PER_CLIENT).toBe(10_000);
		expect(HISTORY_ENTRIES_GLOBAL).toBe(20_000);
		const { blurt, calls } = heldChain();
		open = calls;
		const app = new Hono();
		app.route('/v1/account', accountHistoryRoute(blurt));
		const a1 = from(app, '203.0.113.1', '?limit=10000');
		await tick();
		const a2 = await from(app, '203.0.113.1', '?limit=10000');
		expect(a2.status).toBe(503);
		expect(a2.headers.get('retry-after')).not.toBeNull();
		expect(((await a2.json()) as { code: string }).code).toBe('history_busy');
		const b1 = from(app, '203.0.113.2', '?limit=10000');
		await tick();
		const c1 = await from(app, '203.0.113.3', '?limit=10000');
		expect(c1.status).toBe(503);
		expect(calls).toHaveLength(2); // the refused ones never reached the chain
		for (const c of calls) c.finish();
		expect((await a1).status).toBe(200);
		expect((await b1).status).toBe(200);
		// Freed: the next one is admitted.
		const c2 = from(app, '203.0.113.3', '?limit=10000');
		await tick();
		expect(calls).toHaveLength(3);
		calls[2]!.finish();
		expect((await c2).status).toBe(200);
	});

	it('every Tor/I2P visitor shares one key: together they hold at most one client share', async () => {
		const { blurt, calls } = heldChain();
		open = calls;
		const app = new Hono();
		app.route('/v1/account', accountHistoryRoute(blurt));
		const first = from(app, null, '?limit=10000');
		await tick();
		expect((await from(app, null, '?limit=5000')).status).toBe(503);
		calls[0]!.finish();
		expect((await first).status).toBe(200);
	});

	it('small pages fit alongside each other', async () => {
		const { blurt, calls } = heldChain();
		open = calls;
		const app = new Hono();
		app.route('/v1/account', accountHistoryRoute(blurt));
		const pending = Array.from({ length: 10 }, () => from(app, '203.0.113.9', '?limit=1000'));
		await tick();
		expect(calls).toHaveLength(10);
		for (const c of calls) c.finish();
		expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(10).fill(200));
	});

	it('a large page is never hedged; the default page is 1,000 entries', async () => {
		const { blurt, calls } = heldChain();
		open = calls;
		const app = new Hono();
		app.route('/v1/account', accountHistoryRoute(blurt));
		const big = from(app, '203.0.113.4', '?limit=5000');
		const small = from(app, '203.0.113.5', '');
		await tick();
		const byLimit = new Map(calls.map((c) => [c.params[2], c.opts?.userFacing === true]));
		expect(byLimit.get(5000)).toBe(false);
		expect(byLimit.get(1000)).toBe(true);
		for (const c of calls) c.finish();
		await Promise.all([big, small]);
	});
});
