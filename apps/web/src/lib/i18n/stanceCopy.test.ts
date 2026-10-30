/**
 * What About this instance and /run-a-node say about switched-off assets and
 * payment methods must match what the indexer does: it hides those orders from
 * this instance's pages whichever instance posted them
 * (apps/indexer/src/api/localHiding.ts; before 1 November 2026 the order
 * handler refused them here). An older text said peer instances' orders "still
 * appear in your orderbook".
 */
import { describe, expect, it } from 'vitest';
import en from './locales/en.json';

const texts = {
	'asset_stance.explain': en.about_this_instance.asset_stance.explain,
	'asset_stance.disabled_suffix': en.about_this_instance.asset_stance.disabled_suffix,
	'payment_stance.explain': en.about_this_instance.payment_stance.explain,
	'payment_stance.disabled_suffix': en.about_this_instance.payment_stance.disabled_suffix,
	'run_a_node.asset_policy_federation_body': en.run_a_node.asset_policy_federation_body
};

describe('the stance texts say switched-off orders are hidden here', () => {
	it.each(Object.entries(texts))('%s never says they still show here', (_k, text) => {
		expect(text).not.toMatch(/still (appear|show)[^.]*(your|here)|doesn't hide|can still show/i);
		expect(text).toMatch(/not shown|hides/);
	});
	it('the order-level texts say other instances’ orders are hidden too', () => {
		for (const t of [texts['asset_stance.explain'], texts['payment_stance.explain']])
			expect(t).toMatch(
				/not shown on this instance, including (orders|one) posted on (other|another) instances?/
			);
		expect(texts['run_a_node.asset_policy_federation_body']).toMatch(
			/hides its orders on your own site only, including orders posted on other instances/
		);
	});
});
