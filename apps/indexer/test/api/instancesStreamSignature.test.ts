/**
 * The live directory stream re-sends a row when its signature changes. The
 * zero-clearnet badge was not part of it, so a badge that changed never
 * reached an open directory page.
 */
import { describe, expect, it } from 'vitest';

import { rowSignature } from '$api/instancesStreamHelpers';

describe('instances stream row signature', () => {
	it('changes when the zero-clearnet badge changes', () => {
		const base = {
			origin: 'https://a.example',
			operator_account: 'a',
			operator_tag: null,
			operator_display_name: null,
			name: 'A',
			tagline: null,
			contact_url: null,
			clearnet_eliminated: false,
			alt_networks: {},
			status: 'good',
			indexed_block: 1,
			chain_lag_sec: 0,
			last_probed_at: '2026-10-01T00:00:00Z'
		} as never;
		expect(rowSignature({ ...(base as object), clearnet_eliminated: true } as never)).not.toBe(
			rowSignature(base)
		);
	});
});
