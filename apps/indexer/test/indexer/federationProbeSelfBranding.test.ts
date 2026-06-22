/**
 * cp311 regression — self-instance directory card branding.
 *
 * Bug: the indexer never network-probes its own origin (hairpin-NAT
 * fragile), so `persistSelfReachable` was the only writer of the self
 * row — and it touched ONLY status + the failure counter, never the
 * cached_name / cached_tagline / cached_contact_url / cached_alt_networks
 * columns.  federationSeed doesn't set them either.  Result: the
 * operator's OWN instance card on /instances was stuck on the
 * operator-account fallback, and no `MORPHIT_INSTANCE_NAME` change could
 * ever move it (the var only reaches a peer that network-probes you).
 *
 * Fix: `persistSelfReachable` now refreshes cached_* from `selfBranding`
 * (the same local config /v1/instance serves).  This test drives a full
 * `scanOnce()` against a mock DB whose probe-due SELECT returns the self
 * origin, and asserts the resulting self UPDATE carries the branding.
 */

import { describe, it, expect } from 'vitest';
import type { Database } from '$db/pool';
import type pg from 'pg';
import { FederationProbeScheduler } from '$indexer/federationProbe';

const SELF_ORIGIN = 'https://morphit.io';

interface CapturedQuery {
	readonly text: string;
	readonly params: readonly unknown[];
}

/** Mock Database that:
 *   - DELETE … (dropFailedInstances) → 0 rows
 *   - SELECT … known_instances (pickDueInstances) → one self row
 *   - UPDATE … known_instances (persist) → captured
 *  Records every query so the test can find the self UPDATE. */
function makeMockDb(): { db: Database; queries: CapturedQuery[] } {
	const queries: CapturedQuery[] = [];
	const query = (async (text: string, params: readonly unknown[] = []) => {
		queries.push({ text, params });
		const t = text.trim().toUpperCase();
		if (t.startsWith('DELETE')) return { rows: [], rowCount: 0 };
		if (t.startsWith('SELECT')) {
			return {
				rows: [
					{
						origin: SELF_ORIGIN,
						operator_account: 'morphit',
						registered_at_time: new Date('2026-04-17T00:00:00Z'),
						last_probed_at: null,
						last_probe_status: 'never',
						consecutive_failures: 0
					}
				],
				rowCount: 1
			};
		}
		// UPDATE
		return { rows: [], rowCount: 1 };
	}) as unknown as Database['query'];
	const db: Database = {
		query,
		async withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
			return fn({} as pg.PoolClient);
		},
		async close() {}
	};
	return { db, queries };
}

describe('FederationProbe — self-instance branding refresh (cp311)', () => {
	it('writes cached_name/tagline/contact/alt from selfBranding on the self row', async () => {
		const { db, queries } = makeMockDb();
		const scheduler = new FederationProbeScheduler(db, {
			intervalMs: 15_000,
			selfOrigin: SELF_ORIGIN,
			localLagBlocks: () => 0, // caught up → 'good'
			selfBranding: () => ({
				name: 'Morphit NL',
				tagline: 'Privacy-first P2P',
				contactUrl: 'https://matrix.to/#/@op:example.org',
				altNetworks: {
					tor: 'morphexampleonionaddr.onion',
					lokinet: null,
					i2p_b32: null,
					i2p_name: null,
					nostr: 'npub1exampleexampleexample'
				}
			})
		});

		const res = await scheduler.scanOnce();
		expect(res.probed).toBe(1);

		const update = queries.find(
			(q) => q.text.trim().toUpperCase().startsWith('UPDATE') && q.text.includes('cached_name')
		);
		expect(update, 'self UPDATE must set cached_name').toBeDefined();
		const p = update!.params;
		// [origin, status, name, tagline, contactUrl, altNetworks]
		expect(p[0]).toBe(SELF_ORIGIN);
		expect(p[1]).toBe('good');
		expect(p[2]).toBe('Morphit NL');
		expect(p[3]).toBe('Privacy-first P2P');
		expect(p[4]).toBe('https://matrix.to/#/@op:example.org');
		expect(p[5]).toEqual({
			tor: 'morphexampleonionaddr.onion',
			lokinet: null,
			i2p_b32: null,
			i2p_name: null,
			nostr: 'npub1exampleexampleexample'
		});
	});

	it('without selfBranding, keeps the old status-only behavior (no cached_* clobber)', async () => {
		const { db, queries } = makeMockDb();
		const scheduler = new FederationProbeScheduler(db, {
			intervalMs: 15_000,
			selfOrigin: SELF_ORIGIN,
			localLagBlocks: () => 0
			// no selfBranding
		});
		await scheduler.scanOnce();
		const update = queries.find((q) => q.text.trim().toUpperCase().startsWith('UPDATE'));
		expect(update).toBeDefined();
		// The status-only UPDATE must NOT mention cached_name.
		expect(update!.text.includes('cached_name')).toBe(false);
	});
});
