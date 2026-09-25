/**
 * v1.18.0 deep-deep, L3 — reserved operator TAGS must be matched
 * confusable-aware, not by exact equality only.
 *
 * rv6 L3: `m0rphit`, `rnorphit` and `morphit-io` were all accepted as operator
 * tags (tags are immutable once claimed, so a look-alike is squatted for good),
 * while the display-name guard already used the confusable-aware regexes.
 * Runs the real register handler against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import operatorRegisterHandler from '../../src/indexer/handlers/operatorRegister';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

describe.skipIf(!INTEGRATION_ENABLED)('L3 — confusable reserved operator tags are refused', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query(`TRUNCATE known_instances, operators, operator_registration_events CASCADE`);
	});

	async function register(signer: string, tag: string) {
		return fx.db.withTx((c) =>
			operatorRegisterHandler(
				makeCtx({ signer, payload: { v: 1, tag, display_name: 'Some Node' } }),
				c
			)
		);
	}

	it.each(['m0rphit', 'rnorphit', 'morphit-io', 'agor1se', 'kenc0de-node', 'morph1t.fees'])(
		'a stranger cannot claim the look-alike tag %s',
		async (tag) => {
			const r = await register('mallory', tag);
			expect(r.ok).toBe(false);
			const n = await fx.db.query(`SELECT 1 FROM operators WHERE tag = $1`, [tag]);
			expect(n.rowCount).toBe(0);
		}
	);

	it('ordinary tags — and a brand inside a longer name (P6-3, cp670) — are still accepted', async () => {
		expect(await register('alice', 'alice-node')).toEqual({ ok: true });
		expect(await register('bob', 'mo-phi')).toEqual({ ok: true });
		expect(await register('carol', 'mymorphit')).toEqual({ ok: true });
		expect(await register('morphitlat-relay', 'morphitlat-relay')).toEqual({ ok: true });
	});

	it('the rightful owner may use a tag built on their own reserved name', async () => {
		expect(await register('morphit', 'morphit-latino')).toEqual({ ok: true });
	});

	it('an operator already holding a now-refused tag can still update their registration', async () => {
		// Grandfathered row from before this rule.
		await fx.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block)
			 VALUES ('oldop', 'morphit-io', 'Old', 1)`
		);
		expect(await register('oldop', 'morphit-io')).toEqual({ ok: true });
	});
});
