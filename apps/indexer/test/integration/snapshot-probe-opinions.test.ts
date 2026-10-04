/**
 * a restored snapshot does not bring the PUBLISHER's
 * probe opinions with it.
 *
 * `known_instances` rows are chain-derived (the register op writes them), but
 * their probe columns are the publisher's own NETWORK OBSERVATIONS: status
 * (including 'mismatch' — a fee-redirection accusation), failure counts, the
 * error text, and a peer's self-description as the publisher cached it. A node
 * restoring the snapshot inherited all of it: a row near the 168-failure prune
 * threshold on the publisher was deleted here after ONE local miss, and a
 * 'mismatch' accusation stood until this node re-probed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { scrubRestoredLocalState } from '../../src/db/snapshotLocalState';

describe.skipIf(!INTEGRATION_ENABLED)('restored known_instances rows start unprobed (E12)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('the publisher’s status, failure count, error and cache are wiped; the registration stays', async () => {
		await fx.db.query(`TRUNCATE known_instances`);
		await fx.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time,
			                              last_probed_at, last_probe_status, last_probe_error, consecutive_failures,
			                              cached_name, cached_alt_networks, cached_clearnet_eliminated)
			 VALUES ('https://peer.example', 'peer', 7, NOW(), NOW(), 'mismatch', 'relay_account mismatch', 167,
			         'Peer', '{"tor":null}', TRUE)`
		);
		await scrubRestoredLocalState(fx.db);
		const r = (await fx.db.query(`SELECT * FROM known_instances`)).rows[0];
		expect(r?.operator_account).toBe('peer');
		expect(r?.registered_at_block).toBe('7');
		expect(
			{
				status: r?.last_probe_status,
				probed: r?.last_probed_at,
				failures: r?.consecutive_failures,
				error: r?.last_probe_error,
				name: r?.cached_name,
				alt: r?.cached_alt_networks,
				clearnet: r?.cached_clearnet_eliminated
			},
			'the publisher’s probe opinion survived the restore'
		).toEqual({
			status: 'never',
			probed: null,
			failures: 0,
			error: null,
			name: null,
			alt: null,
			clearnet: false
		});
	});
});
