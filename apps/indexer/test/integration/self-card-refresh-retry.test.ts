/**
 * The own-card refresh at the first scan after a start (v1.21.10) must not be
 * spent by a refresh that failed: if writing the card fails that once (the
 * database busy for a moment), the next scan tries again — else the card keeps
 * the old contact until it next falls due, which is what the refresh was
 * added to stop. v1.21.10 review. Real Postgres.
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
const OLD = 'https://matrix.to/#/#morphit:matrix.org';
const NEW = 'mailto:operator@example.org';

describe.skipIf(!INTEGRATION_ENABLED)(
	'own card refresh after a start, when writing it fails once',
	() => {
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
			await fx.db.query(
				`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time,
			                              last_probe_status, last_probed_at, cached_contact_url)
			 VALUES ($1, 'morphit', 1, NOW() - INTERVAL '30 days', 'good', NOW() - INTERVAL '1 minute', $2)`,
				[SELF, OLD]
			);
		});

		it('the next scan writes it', async () => {
			let failOnce = true;
			const db = Object.create(fx.db) as typeof fx.db;
			db.query = ((sql: string, params?: unknown[]) => {
				if (failOnce && /UPDATE known_instances SET/.test(sql) && /cached_contact_url/.test(sql)) {
					failOnce = false;
					return Promise.reject(new Error('canceling statement due to statement timeout'));
				}
				return fx.db.query(sql, params as never);
			}) as typeof fx.db.query;
			const s = new FederationProbeScheduler(db, {
				intervalMs: 0,
				selfOrigin: SELF,
				localLagBlocks: () => 0,
				clearnetFetch: (async () => {
					throw new Error('no network in this test');
				}) as <T>(u: string) => Promise<T>,
				selfBranding: () => ({
					name: 'Morphit',
					tagline: null,
					contactUrl: NEW,
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
			await s.scanOnce();
			expect(failOnce).toBe(false);
			await s.scanOnce();
			const row = await fx.db.query<{ cached_contact_url: string }>(
				`SELECT cached_contact_url FROM known_instances WHERE origin = $1`,
				[SELF]
			);
			expect(row.rows[0]?.cached_contact_url).toBe(NEW);
		});

		it('a site whose own origin is an .onion: refreshed from its settings, never fetched', async () => {
			const ONION = `http://${'a'.repeat(56)}.onion`;
			await fx.db.query(`UPDATE known_instances SET origin = $1 WHERE origin = $2`, [ONION, SELF]);
			const fetched: string[] = [];
			const record = (async (u: string) => {
				fetched.push(u);
				throw new Error('no network in this test');
			}) as <T>(u: string) => Promise<T>;
			await new FederationProbeScheduler(fx.db, {
				intervalMs: 0,
				selfOrigin: `${ONION}/`,
				localLagBlocks: () => 0,
				clearnetFetch: record,
				hiddenServiceProxies: { tor: '127.0.0.1:1', i2p: '127.0.0.1:1' } as never,
				selfBranding: () => ({
					name: 'Morphit',
					tagline: null,
					contactUrl: NEW,
					altNetworks: {
						tor: null,
						lokinet: null,
						i2p_b32: null,
						i2p_name: null,
						ens: null,
						nostr: null
					}
				})
			}).scanOnce();
			const row = await fx.db.query<{
				cached_contact_url: string;
				last_probe_error: string | null;
			}>(`SELECT cached_contact_url, last_probe_error FROM known_instances WHERE origin = $1`, [
				ONION
			]);
			expect(row.rows[0]).toEqual({ cached_contact_url: NEW, last_probe_error: null });
			expect(fetched).toEqual([]);
		});
	}
);
