/**
 * The directory's "Zero use of clearnet internet" badge. It is the
 * peer's own claim; an instance registered at a clearnet origin serves
 * clearnet, so its claim is never stored as TRUE — it used to be, for anyone
 * who answered `clearnet_eliminated: true` over plain HTTPS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import {
	FederationProbeScheduler,
	clearnetEliminatedClaimAccepted
} from '../../src/indexer/federationProbe';
import { instancesRoute } from '../../src/api/instances';

describe('zero-clearnet claim acceptance (pure)', () => {
	it('only an instance registered at a hidden origin keeps the claim', () => {
		expect(clearnetEliminatedClaimAccepted('https://evil-clearnet.example', true)).toBe(false);
		expect(clearnetEliminatedClaimAccepted(`http://${'a'.repeat(56)}.onion`, true)).toBe(true);
		expect(clearnetEliminatedClaimAccepted('http://x.b32.i2p', true)).toBe(true);
		expect(clearnetEliminatedClaimAccepted(`http://${'a'.repeat(56)}.onion`, false)).toBe(false);
	});
});

describe.skipIf(!INTEGRATION_ENABLED)('zero-clearnet badge through a real probe', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('a clearnet peer that claims zero clearnet gets no badge', async () => {
		await fx.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time)
			 VALUES ('https://evil-clearnet.example', 'evilop', 1, NOW())`
		);
		const fetchFn = async <T>(url: string): Promise<T> => {
			if (url.endsWith('/v1/instance'))
				return {
					relay_account: 'evilop',
					alt_networks: { tor: null, lokinet: null, nostr: null },
					clearnet_eliminated: true,
					name: 'Totally Private'
				} as unknown as T;
			if (url.endsWith('/v1/health'))
				return { status: 'ok', indexed_block: 100, lag_blocks: 1 } as unknown as T;
			return { orders: [{ created_at: new Date().toISOString() }] } as unknown as T;
		};
		await new FederationProbeScheduler(fx.db, { intervalMs: 0, clearnetFetch: fetchFn }).scanOnce();
		const body = (await (await instancesRoute(fx.db).request('/')).json()) as {
			instances: Array<{
				origin: string;
				status: string;
				name: unknown;
				clearnet_eliminated: boolean;
			}>;
		};
		const e = body.instances.find((i) => i.origin === 'https://evil-clearnet.example')!;
		expect(e.status, 'the probe reached it').toBe('good');
		expect(e.name).toBe('Totally Private');
		expect(
			e.clearnet_eliminated,
			'a clearnet origin was badged zero-clearnet on its own word'
		).toBe(false);
	});
});
