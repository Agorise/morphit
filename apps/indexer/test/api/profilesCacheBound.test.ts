/**
 * The warm profile cache is bounded.
 *
 * Every profile anyone looked up stayed cached (avatar included) until the
 * process restarted: about 150 MiB per 20,000 profiles. The cache now keeps
 * the most recently used profiles only.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';

import { profilesRoute } from '$api/profiles';
import type { Database } from '$db/pool';

function countingDb(): { db: Database; asked: string[][] } {
	const asked: string[][] = [];
	const db = {
		async query<R extends pg.QueryResultRow>(_text: string, params?: readonly unknown[]) {
			const accounts = (params?.[0] ?? []) as string[];
			asked.push(accounts);
			const rows = accounts.map((a) => ({
				account: a,
				display_name: a,
				json_metadata: {},
				source_block_num: '1',
				updated_at: new Date(),
				posting_pubkey: null,
				has_profile: true
			}));
			return {
				rows: rows as unknown as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			};
		}
	} as unknown as Database;
	return { db, asked };
}

describe('profiles cache', () => {
	it('keeps the most recently used profiles, not every profile ever read', async () => {
		const { db, asked } = countingDb();
		const app = profilesRoute(db, { maxCached: 3 });
		for (const a of ['alice', 'bob', 'carol', 'dave']) await app.request(`/?accounts=${a}`);
		asked.length = 0;
		await app.request('/?accounts=dave'); // recent: warm
		expect(asked).toEqual([]);
		await app.request('/?accounts=alice'); // least recently used: evicted
		expect(asked).toEqual([['alice']]);
	});
});
