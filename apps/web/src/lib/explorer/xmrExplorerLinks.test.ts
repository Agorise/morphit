/**
 * v1.20.0 (wave 4) — Monero "open in explorer" links. localmonero.co/blocks now
 * redirects to moneroblocks.info (checked 2026-09-28), so it is not a separate
 * alternative any more; moneroblocks.info's tx page is /tx/<txid> (checked).
 */
import { describe, expect, it } from 'vitest';

import { BUNDLED_XMR_CHAT_LINK_URLS } from './urlsCore';

describe('Monero explorer links', () => {
	it('offers moneroblocks.info and no dead localmonero.co link', () => {
		expect(BUNDLED_XMR_CHAT_LINK_URLS).toContain('https://moneroblocks.info/tx/{txid}');
		expect(BUNDLED_XMR_CHAT_LINK_URLS.some((u) => u.includes('localmonero'))).toBe(false);
		expect(new Set(BUNDLED_XMR_CHAT_LINK_URLS).size).toBe(BUNDLED_XMR_CHAT_LINK_URLS.length);
	});
});
