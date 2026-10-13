/**
 * The guided install offers fast-sync.
 *
 * Only the "Configure only" path offered to restore the federation snapshot;
 * the full guided install never asked, so a fresh VPS started replaying the
 * whole chain from genesis — 4.8 million blocks behind (2026-10-12).
 */
import { describe, expect, it } from 'vitest';

import { offerFastSync } from '../src/init/runAnsibleInstall.ts';

function run(o: {
	yes: boolean;
	stops?: boolean;
	syncRc?: number;
	reinstall?: boolean;
	online?: boolean;
}) {
	const order: string[] = [];
	const out: string[] = [];
	const defaults: boolean[] = [];
	return offerFastSync({
		reinstall: o.reinstall ?? false,
		online: o.online ?? true,
		askYesNo: async (_q, def) => (defaults.push(def), o.yes),
		stopIndexer: async () => {
			order.push('stop');
			return o.stops ?? true;
		},
		fastSync: () => {
			order.push('sync');
			return o.syncRc ?? 0;
		},
		startIndexer: async () => void order.push('start'),
		print: (s) => void out.push(s)
	}).then((r) => ({ r, order, out: out.join('\n'), defaults }));
}

describe('fast-sync during the guided install', () => {
	it('yes: stops the indexer, restores the snapshot, starts the indexer again', async () => {
		const { r, order } = await run({ yes: true });
		expect(order).toEqual(['stop', 'sync', 'start']);
		expect(r).toBe('synced');
	});

	it('a failed restore still starts the indexer again, and says how to retry', async () => {
		const { r, order, out } = await run({ yes: true, syncRc: 1 });
		expect(order).toEqual(['stop', 'sync', 'start']);
		expect(r).toBe('failed');
		expect(out).toContain('sudo morphit-ops fast-sync');
	});

	it('an indexer that will not stop is never restored under', async () => {
		const { r, order, out } = await run({ yes: true, stops: false });
		expect(order).toEqual(['stop', 'start']);
		expect(r).toBe('failed');
		expect(out).toContain('sudo morphit-ops fast-sync');
	});

	it('a fresh install is offered it with yes as the default', async () => {
		const { defaults } = await run({ yes: true });
		expect(defaults).toEqual([true]);
	});

	it('a re-install over an existing node defaults to no: its own data would be replaced', async () => {
		// Its own pending payouts, push subscriptions and moderation live in the
		// same database, and a restore replaces it.
		const { defaults } = await run({ yes: false, reinstall: true });
		expect(defaults).toEqual([false]);
	});

	it('offline: not offered (it could only fail), says how to do it later', async () => {
		const { r, order, defaults, out } = await run({ yes: true, online: false });
		expect(defaults).toEqual([]);
		expect(order).toEqual([]);
		expect(r).toBe('skipped');
		expect(out).toContain('sudo morphit-ops fast-sync');
	});

	it('no: touches nothing, and says how to do it later', async () => {
		const { r, order, out } = await run({ yes: false });
		expect(order).toEqual([]);
		expect(r).toBe('skipped');
		expect(out).toContain('sudo morphit-ops fast-sync');
	});
});
