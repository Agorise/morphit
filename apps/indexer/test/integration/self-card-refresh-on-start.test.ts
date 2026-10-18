/**
 * This site's own card on /instances takes a changed contact link (or name,
 * tagline, address) at the first scan after the indexer starts (v1.21.10).
 *
 * 2026-10-17: the operator changed the contact from a Matrix room to an email
 * address with `morphit-ops edit`, which restarts the indexer. The footer (read
 * from the indexer's settings) showed the new link at once; the Instances card
 * (read from known_instances) kept "Contact via Matrix", because the self row
 * was only rewritten when it next fell due. The real scheduler against real
 * Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FederationProbeScheduler } from '../../src/indexer/federationProbe';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const SELF = 'https://morphit.io';
const PEER = 'https://peer.example';
const OLD = 'https://matrix.to/#/#morphit:matrix.org';
const NEW = 'mailto:operator@example.org';

describe.skipIf(!INTEGRATION_ENABLED)('own card refreshed at the first scan after a start', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query(`TRUNCATE known_instances, operators CASCADE`);
		// Both rows were checked a minute ago: neither is due.
		await fx.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time,
			                              last_probe_status, last_probed_at, cached_contact_url)
			 VALUES ($1, 'morphit', 1, NOW() - INTERVAL '30 days', 'good', NOW() - INTERVAL '1 minute', $2),
			        ($3, 'alice', 2, NOW() - INTERVAL '30 days', 'good', NOW() - INTERVAL '1 minute', 'mailto:a@peer.example')`,
			[SELF, OLD, PEER]
		);
	});

	const scheduler = (selfOrigin: string, contactUrl: string, fetched: string[]) =>
		new FederationProbeScheduler(fx.db, {
			intervalMs: 0,
			selfOrigin,
			localLagBlocks: () => 0,
			clearnetFetch: (async (u: string) => {
				fetched.push(u);
				throw new Error('no network in this test');
			}) as <T>(u: string) => Promise<T>,
			selfBranding: () => ({
				name: 'Morphit',
				tagline: null,
				contactUrl,
				altNetworks: {
					tor: null,
					lokinet: null,
					i2p_b32: null,
					i2p_name: null,
					ens: null,
					nostr: null
				}
			})
		});
	const card = async (origin: string) =>
		(
			await fx.db.query<{ cached_contact_url: string | null }>(
				`SELECT cached_contact_url FROM known_instances WHERE origin = $1`,
				[origin]
			)
		).rows[0]?.cached_contact_url;

	it('the first scan writes the new contact on our card; peers that are not due are left alone', async () => {
		const fetched: string[] = [];
		const s = scheduler(SELF, NEW, fetched);
		const r = await s.scanOnce();
		expect(r.probed).toBe(1);
		expect(await card(SELF)).toBe(NEW);
		expect(await card(PEER)).toBe('mailto:a@peer.example');
		expect(fetched).toEqual([]);
	});

	it('only the first scan: later ones wait until the card is due again', async () => {
		const s = scheduler(SELF, NEW, []);
		await s.scanOnce();
		await fx.db.query(`UPDATE known_instances SET cached_contact_url = $1 WHERE origin = $2`, [
			OLD,
			SELF
		]);
		expect((await s.scanOnce()).probed).toBe(0);
		expect(await card(SELF)).toBe(OLD);
	});

	it('the origin is matched like everywhere else (case, a trailing slash)', async () => {
		await fx.db.query(
			`UPDATE known_instances SET origin = 'https://Morphit.IO/' WHERE origin = $1`,
			[SELF]
		);
		await scheduler('HTTPS://morphit.io', NEW, []).scanOnce();
		expect(await card('https://Morphit.IO/')).toBe(NEW);
	});

	it('when our row is already due it is refreshed once, not twice', async () => {
		await fx.db.query(
			`UPDATE known_instances SET last_probed_at = NOW() - INTERVAL '3 hours' WHERE origin = $1`,
			[SELF]
		);
		const r = await scheduler(SELF, NEW, []).scanOnce();
		expect(r.probed).toBe(1);
		expect(await card(SELF)).toBe(NEW);
	});

	it('no row for this site yet (not registered): nothing is written', async () => {
		const r = await scheduler('https://elsewhere.example', NEW, []).scanOnce();
		expect(r.probed).toBe(0);
		expect(await card(SELF)).toBe(OLD);
	});
});
