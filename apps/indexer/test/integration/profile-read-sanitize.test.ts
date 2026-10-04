/**
 * A profile stored before the profile handler tightened its rules is served
 * without the fields it would now refuse (read-side heal), on real
 * Postgres: the profile routes and the orderbook card's inline identity.
 *
 * Rows already in the table keep whatever was sent then — a `javascript:`
 * website link, a bio with bidi overrides — and every read path handed them to
 * browsers as they were.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { profilesRoute } from '../../src/api/profiles';
import { orderbookRoute } from '../../src/api/orderbook';
import type { Poller } from '../../src/indexer/poller';

const poller = { getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller;
const STORED = {
	website_url: 'javascript:alert(1)',
	short_bio: 'hello ‮evil',
	nostr_url: 'https://example.org/me',
	preferred_langs: ['en']
};

describe.skipIf(!INTEGRATION_ENABLED)('stored profiles are served sanitised', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await fx.db.query(
			`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id)
			 VALUES ('alice', 'c', 1, NOW(), 't1')`
		);
		await fx.db.query(
			`INSERT INTO profiles (account, display_name, json_metadata, source_block_num, source_trx_id, updated_at)
			 VALUES ('alice', 'Alice', $1::jsonb, 1, 'p1', NOW())`,
			[JSON.stringify(STORED)]
		);
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, fee_status)
			 VALUES ('alice', 'o', 'sell', 'BTC', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
			         'live', NOW(), NOW(), 'verified')`
		);
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	const EXPECTED = { nostr_url: 'https://example.org/me', preferred_langs: ['en'] };

	it('single and batch profile reads', async () => {
		const app = profilesRoute(fx.db);
		const one = (await (await app.request('/alice')).json()) as { json_metadata: unknown };
		expect(one.json_metadata).toEqual(EXPECTED);
		const batch = (await (await app.request('/?accounts=alice')).json()) as {
			profiles: Record<string, { json_metadata: unknown }>;
		};
		expect(batch.profiles.alice!.json_metadata).toEqual(EXPECTED);
	});

	it('the orderbook card’s inline identity', async () => {
		const res = await orderbookRoute(fx.db, poller, 'op').request('/');
		const items = ((await res.json()) as { items: { profile_json_metadata: unknown }[] }).items;
		expect(items[0]!.profile_json_metadata).toEqual(EXPECTED);
	});
});
