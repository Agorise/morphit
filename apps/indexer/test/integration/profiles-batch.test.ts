/**
 * Integration test — the /v1/profiles batch endpoint, driven through the real
 * route (profilesRoute) against a real Postgres.
 *
 * It used to run a COPY of the batch SELECT. The copy stayed the old
 * profiles-only query while the handler moved to one anchored on `accounts`
 * (v1.5.5), so nothing noticed that the batch had stopped returning an account
 * with a profile but no `accounts` row. `accounts` is written only for account
 * creations this indexer saw and for a first-buy waiver or first-trade bonus
 * claim, so an older account this indexer never recorded (@classx, 2026-11-01)
 * got the identicon in the header, the orderbook and chat while its own
 * profile page — the single route, profiles-anchored — showed its avatar.
 * Driving the route keeps the test on the SQL that actually runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { profilesRoute } from '$api/profiles';

import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const KEY = 'BLT6LLegbAgLAy28EHrffBVuANFWcFgmqRMW13wBmTExqFE9SCkg4';

async function insertProfile(
	fx: IntegrationFixture,
	account: string,
	display_name: string,
	json_metadata: Record<string, unknown> = {}
): Promise<void> {
	await fx.db.query(
		`INSERT INTO profiles (
			account, display_name, json_metadata,
			source_block_num, source_trx_id, updated_at
		) VALUES ($1, $2, $3, $4, $5, NOW())`,
		[account, display_name, json_metadata, 1, '0000000000000000000000000000000000000000']
	);
}

/** An `accounts` row (the indexer saw the account created, or it ordered / reviewed). */
async function insertAccount(
	fx: IntegrationFixture,
	name: string,
	postingPubkey: string | null
): Promise<void> {
	await fx.db.query(
		`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, posting_pubkey)
		 VALUES ($1, 'blurt', 1, NOW(), '0000000000000000000000000000000000000000', $2)`,
		[name, postingPubkey]
	);
}

interface BatchBody {
	readonly profiles: Record<
		string,
		{
			readonly account: string;
			readonly display_name: string | null;
			readonly json_metadata: Record<string, unknown> | null;
			readonly posting_pubkey: string | null;
		}
	>;
}

async function batch(
	fx: IntegrationFixture,
	accounts: readonly string[]
): Promise<{ body: BatchBody; cache: string | null }> {
	const app = profilesRoute(fx.db);
	const res = await app.request(`/?accounts=${accounts.join(',')}`);
	expect(res.status).toBe(200);
	return { body: (await res.json()) as BatchBody, cache: res.headers.get('cache-control') };
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'batch profiles endpoint — the real route on Postgres',
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
		});

		it('an account with a profile and no accounts row is returned, avatar and all', async () => {
			const svg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="9"/></svg>';
			await insertProfile(fx, 'classx', 'ClassX', { avatar_svg: svg });
			const { body, cache } = await batch(fx, ['classx']);
			expect(Object.keys(body.profiles)).toEqual(['classx']);
			expect(body.profiles.classx!.display_name).toBe('ClassX');
			expect(body.profiles.classx!.json_metadata?.avatar_svg).toBe(svg);
			expect(body.profiles.classx!.posting_pubkey).toBeNull();
			// Every requested account has a profile: the answer may be kept.
			expect(cache).toMatch(/max-age=90/);
		});

		it('an account with a key and no profile is still returned, for its key (v1.5.5)', async () => {
			await insertAccount(fx, 'keyonly', KEY);
			const { body, cache } = await batch(fx, ['keyonly']);
			expect(body.profiles.keyonly!.posting_pubkey).toBe(KEY);
			expect(body.profiles.keyonly!.display_name).toBeNull();
			expect(body.profiles.keyonly!.json_metadata).toBeNull();
			// No profile yet is never pinned in a browser cache.
			expect(cache).toBe('no-store');
		});

		it('an account with both carries its profile and its key', async () => {
			await insertAccount(fx, 'alice', KEY);
			await insertProfile(fx, 'alice', 'Alice');
			const { body } = await batch(fx, ['alice']);
			expect(body.profiles.alice!.display_name).toBe('Alice');
			expect(body.profiles.alice!.posting_pubkey).toBe(KEY);
		});

		it('a mixed batch returns exactly the accounts known to either table', async () => {
			await insertProfile(fx, 'classx', 'ClassX');
			await insertAccount(fx, 'keyonly', KEY);
			await insertAccount(fx, 'alice', KEY);
			await insertProfile(fx, 'alice', 'Alice');
			const { body, cache } = await batch(fx, ['classx', 'nobody', 'keyonly', 'alice', 'ghost']);
			expect(Object.keys(body.profiles).sort()).toEqual(['alice', 'classx', 'keyonly']);
			expect(cache).toBe('no-store');
		});

		it('nothing known: an empty answer, never stored; a known row carries every field', async () => {
			const empty = await batch(fx, ['nobody', 'ghost']);
			expect(empty.body.profiles).toEqual({});
			expect(empty.cache).toBe('no-store');

			await insertAccount(fx, 'alice', KEY);
			await insertProfile(fx, 'alice', 'Alice', { about: 'hi' });
			const { body } = await batch(fx, ['alice']);
			expect(Object.keys(body.profiles.alice!).sort()).toEqual(
				[
					'account',
					'display_name',
					'json_metadata',
					'posting_pubkey',
					'source_block_num',
					'updated_at'
				].sort()
			);
			expect(body.profiles.alice!).toMatchObject({
				account: 'alice',
				display_name: 'Alice',
				json_metadata: { about: 'hi' },
				posting_pubkey: KEY,
				source_block_num: 1
			});
		});

		it('duplicates in the request come back once', async () => {
			await insertProfile(fx, 'alice', 'Alice');
			const { body } = await batch(fx, ['alice', 'alice', 'alice']);
			expect(Object.keys(body.profiles)).toEqual(['alice']);
		});

		it('handles a batch at the max size (100), profile-only accounts included', async () => {
			const accounts: string[] = [];
			for (let i = 0; i < 100; i++) {
				const name = `user${String(i).padStart(3, '0')}`;
				accounts.push(name);
				await insertProfile(fx, name, `User ${i}`);
				if (i % 2 === 0) await insertAccount(fx, name, KEY);
			}
			const { body, cache } = await batch(fx, accounts);
			expect(Object.keys(body.profiles)).toHaveLength(100);
			expect(cache).toMatch(/max-age=90/);
		});
	}
);
