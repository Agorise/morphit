/**
 * v1.20.0 (MK-H2) — the treasury auto-re-pin must carry the pinned BTC xpub.
 *
 * A re-pin is a new release op whose treasury block becomes the pin in force.
 * If it dropped `btc.xpub`, every BTC order after it would fall back to the
 * shared-address txid path — the one a watcher can steal from — and the
 * per-order address sequence would stop. It changes amounts, never keys.
 */
import { describe, expect, it } from 'vitest';

import {
	buildRepinnedTreasury,
	decideRepin,
	parseReleaseTreasury
} from '../../src/lib/treasuryRepin';
import { validateTreasury } from '@morphit/release-schema';

const XPUB =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';

describe('treasury re-pin keeps the BTC xpub', () => {
	it('carries btc.xpub into the re-pinned block, which still validates', () => {
		const current = {
			btc: { address: 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk', satoshis: 400, xpub: XPUB },
			xmr: null
		};
		const parsed = parseReleaseTreasury(current);
		const decision = decideRepin(
			parsed.pinned,
			{ btcUsd: 100_000, xmrUsd: null, blurtUsd: null },
			0.05
		);
		const next = buildRepinnedTreasury(decision, parsed.addresses, parsed.pinned);
		expect(next.btc?.xpub).toBe(XPUB);
		expect(next.btc?.satoshis).not.toBe(400);
		const v = validateTreasury(next);
		expect(v.ok && v.value?.btc?.xpub).toBe(XPUB);
	});

	it('does not invent an xpub when none was pinned', () => {
		const parsed = parseReleaseTreasury({
			btc: { address: 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk', satoshis: 400 },
			xmr: null
		});
		const next = buildRepinnedTreasury(
			decideRepin(parsed.pinned, { btcUsd: 100_000, xmrUsd: null, blurtUsd: null }, 0.05),
			parsed.addresses,
			parsed.pinned
		);
		expect(next.btc !== null && 'xpub' in next.btc).toBe(false);
	});

	it('carries xmr.primary_address too (bound XMR fees stay bound)', () => {
		const PRIMARY =
			'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
		const current = {
			btc: null,
			xmr: {
				address:
					'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe',
				piconero: '781250000',
				primary_address: PRIMARY
			}
		};
		const parsed = parseReleaseTreasury(current);
		const decision = decideRepin(
			parsed.pinned,
			{ btcUsd: null, xmrUsd: 100, blurtUsd: null },
			0.05
		);
		const next = buildRepinnedTreasury(decision, parsed.addresses, parsed.pinned);
		expect(next.xmr?.primary_address).toBe(PRIMARY);
		const v = validateTreasury(next);
		expect(v.ok && v.value?.xmr?.primary_address).toBe(PRIMARY);
	});
});
