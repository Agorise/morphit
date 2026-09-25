/**
 * v1.18.0 deep-deep, M4 — registering someone else's origin first must not
 * lock the real operator out of the federation directory.
 *
 * rv6 A5: `known_instances` is keyed on origin and the register handler did
 * `ON CONFLICT (origin) DO NOTHING`, so whoever registered an origin FIRST owned
 * its row forever. A squatter watching CT logs registers `https://legit.example`
 * before its operator; the operator's own registration then succeeds but the
 * row stays the squatter's, and every node probes the real node, sees
 * relay_account=honest against chain=mallory, and marks it `mismatch` — a
 * public fee-redirection accusation the real operator cannot clear.
 *
 * Also: unlimited free registrations flooded the probe queue (never-probed rows
 * sort first, LIMIT 200) ahead of real peers.
 *
 * Runs the real register handler and the real FederationProbeScheduler pass
 * against real Postgres; only the peer's HTTP answers are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import operatorRegisterHandler from '../../src/indexer/handlers/operatorRegister';
import {
	FederationProbeScheduler,
	MAX_NEW_PROBES_PER_SCAN
} from '../../src/indexer/federationProbe';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const NOW = new Date('2026-09-24T12:00:00Z');
const ORIGIN = 'https://legit-node.example';

/** A peer that answers /v1/instance as `relay`, healthy, with an orderbook. */
function peerFetch(relayFor: (origin: string) => string, seen: string[] = []) {
	return async <T>(url: string): Promise<T> => {
		seen.push(url);
		const origin = url.replace(/\/v1\/.*$/, '');
		if (url.endsWith('/v1/instance'))
			return {
				name: 'Node',
				tagline: null,
				contact_url: null,
				relay_account: relayFor(origin),
				alt_networks: { tor: null, lokinet: null, nostr: null }
			} as unknown as T;
		if (url.endsWith('/v1/health'))
			return { status: 'ok', lag_blocks: 0, indexed_block: 100 } as unknown as T;
		return { orders: [{ created_at: new Date().toISOString() }] } as unknown as T;
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'M4 — origin ownership follows the probe-confirmed registrant',
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
			await fx.db.query(
				`TRUNCATE known_instances, operators, operator_registration_events CASCADE`
			);
		});

		async function register(signer: string, tag: string, origin: string, block = 1) {
			return fx.db.withTx((c) =>
				operatorRegisterHandler(
					makeCtx({
						signer,
						blockNum: block,
						blockTime: NOW,
						payload: { v: 1, tag, display_name: `${tag} node`, origin }
					}),
					c
				)
			);
		}
		async function row(origin = ORIGIN) {
			const r = await fx.db.query<{ operator_account: string; last_probe_status: string }>(
				`SELECT operator_account, last_probe_status FROM known_instances WHERE origin = $1`,
				[origin]
			);
			return r.rows[0];
		}
		function scheduler(fetchFn: ReturnType<typeof peerFetch>) {
			return new FederationProbeScheduler(fx.db, { intervalMs: 0, clearnetFetch: fetchFn });
		}

		it('a squatter who registered first loses the row once the origin names the real operator', async () => {
			expect(await register('mallory', 'mal', ORIGIN, 1)).toEqual({ ok: true });
			expect(await register('honest', 'honest', ORIGIN, 2)).toEqual({ ok: true });
			await scheduler(peerFetch(() => 'honest')).scanOnce();
			const r = await row();
			expect(r?.operator_account).toBe('honest');
			expect(r?.last_probe_status).not.toBe('mismatch');
		});

		it('a later squatter cannot take a row the origin confirms for its owner', async () => {
			await register('honest', 'honest', ORIGIN, 1);
			await register('mallory', 'mal', ORIGIN, 2);
			await scheduler(peerFetch(() => 'honest')).scanOnce();
			expect((await row())?.operator_account).toBe('honest');
			expect((await row())?.last_probe_status).not.toBe('mismatch');
		});

		it('an origin naming an account that never registered it is still a mismatch', async () => {
			await register('mallory', 'mal', ORIGIN, 1);
			await scheduler(peerFetch(() => 'someone-else')).scanOnce();
			expect(await row()).toEqual({ operator_account: 'mallory', last_probe_status: 'mismatch' });
		});

		it('a flood of never-probed registrations cannot starve an established peer', async () => {
			// One established peer, due for its periodic re-probe.
			await fx.db.query(
				`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time,
			                              last_probed_at, last_probe_status)
			 VALUES ('https://old-peer.example', 'oldop', 1, $1, NOW() - INTERVAL '2 hours', 'good')`,
				[NOW]
			);
			// ...and 250 brand-new registrations (> the 200-row probe limit).
			const values: string[] = [];
			for (let i = 0; i < 250; i++) {
				values.push(`('https://spam${i}.example', 'spam${i}', ${10 + i}, NOW(), 'never')`);
			}
			await fx.db.query(
				`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time,
			                              last_probe_status) VALUES ${values.join(',')}`
			);
			const seen: string[] = [];
			const { probed } = await scheduler(peerFetch((o) => o, seen)).scanOnce();
			expect(seen).toContain('https://old-peer.example/v1/instance');
			const newProbed = seen.filter(
				(u) => u.startsWith('https://spam') && u.endsWith('/v1/instance')
			);
			expect(newProbed.length).toBeLessThanOrEqual(MAX_NEW_PROBES_PER_SCAN);
			// Oldest registrations first (deterministic by chain block).
			expect(newProbed).toContain('https://spam0.example/v1/instance');
			expect(probed).toBeLessThanOrEqual(MAX_NEW_PROBES_PER_SCAN + 1);
		});
	}
);
