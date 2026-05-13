/**
 * B3 regression suite — operator-block + operator-payment-method
 * gates use operatorAccountName (per-instance), not
 * officialAccountName (federation-wide release-signer).
 *
 * Pre-fix: a community operator running their own instance had to
 * choose between accepting Morphit-canonical releases (gate=morphit)
 * or curating their own block list (gate=their own account).
 *
 * Post-fix: officialAccountName stays as the release trust anchor;
 * operatorAccountName is the per-instance moderation gate. Both
 * default to the same value for back-compat with the canonical
 * morphit.io deployment.
 */

import { describe, expect, it } from 'vitest';
import operatorBlockHandler from '$indexer/handlers/operatorBlock';
import operatorPaymentMethodHandler from '$indexer/handlers/operatorPaymentMethod';
import { makeCtx } from '../testutils/context';
import { fakeConfig } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

describe('B3 regression — operator-block + payment-method gates', () => {
	it('B3: community operator can curate own instance with operatorAccountName=bob', async () => {
		// Bob runs his own Morphit instance. He sets:
		//   officialAccountName  = morphit  (release verification anchor)
		//   operatorAccountName  = bob      (his per-instance moderation gate)
		// He signs a block op against alice from his own account.
		const config = fakeConfig({
			officialAccountName: 'morphit',
			operatorAccountName: 'bob'
		});
		const mock = makeMockClient([
			{ match: 'SELECT state FROM operator_blocks', rows: [] },
			{ match: 'INSERT INTO operator_blocks', rowCount: 1 }
		]);
		const r = await operatorBlockHandler(
			makeCtx({
				signer: 'bob',
				config,
				payload: {
					v: 1,
					blocked: 'alice',
					action: 'block',
					reason: 'spamming the orderbook',
					ts: 1730000000
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it("B3: morphit (the release-signer) is rejected on bob's instance", async () => {
		// Inverse case: morphit signs a block op, but Bob's instance
		// has operatorAccountName=bob, so morphit's signature is
		// rejected as not_operator. Releases signed by morphit still
		// pass through release.ts (different trust anchor).
		const config = fakeConfig({
			officialAccountName: 'morphit',
			operatorAccountName: 'bob'
		});
		const mock = makeMockClient();
		const r = await operatorBlockHandler(
			makeCtx({
				signer: 'morphit',
				config,
				payload: {
					v: 1,
					blocked: 'alice',
					action: 'block',
					reason: 'spamming',
					ts: 1730000000
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'not_operator' });
		// No DB query attempted.
		expect(mock.queries).toHaveLength(0);
	});

	it('B3: canonical morphit instance (both knobs = morphit) still works', async () => {
		// Back-compat case. The canonical morphit.io deployment leaves
		// operatorAccountName empty in env (= falls back to
		// officialAccountName='morphit'). Both gates allow morphit.
		const config = fakeConfig({
			officialAccountName: 'morphit',
			operatorAccountName: 'morphit'
		});
		const mock = makeMockClient([
			{ match: 'SELECT state FROM operator_blocks', rows: [] },
			{ match: 'INSERT INTO operator_blocks', rowCount: 1 }
		]);
		const r = await operatorBlockHandler(
			makeCtx({
				signer: 'morphit',
				config,
				payload: {
					v: 1,
					blocked: 'alice',
					action: 'block',
					reason: 'spam',
					ts: 1730000000
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('B3: operatorPaymentMethod uses the same operatorAccountName gate', async () => {
		const config = fakeConfig({
			officialAccountName: 'morphit',
			operatorAccountName: 'bob'
		});
		// bob is allowed.
		const mockBob = makeMockClient([
			{ match: 'SELECT state', rows: [] },
			{ match: 'INSERT INTO instance_payment_methods', rowCount: 1 }
		]);
		const rBob = await operatorPaymentMethodHandler(
			makeCtx({
				signer: 'bob',
				config,
				payload: {
					v: 1,
					action: 'add',
					key: 'wechat',
					name: 'WeChat Pay',
					description: 'Available for clients in PRC',
					category: 'online',
					url: 'https://pay.weixin.qq.com',
					ts: 1730000000
				}
			}),
			mockBob.client
		);
		expect(rBob).toEqual({ ok: true });

		// morphit is NOT allowed on bob's instance.
		const mockMorphit = makeMockClient();
		const rMorphit = await operatorPaymentMethodHandler(
			makeCtx({
				signer: 'morphit',
				config,
				payload: {
					v: 1,
					action: 'add',
					key: 'wechat',
					name: 'WeChat Pay',
					description: '...',
					category: 'online',
					url: null,
					ts: 1730000000
				}
			}),
			mockMorphit.client
		);
		expect(rMorphit).toEqual({ ok: false, reason: 'not_operator' });
		expect(mockMorphit.queries).toHaveLength(0);
	});
});
