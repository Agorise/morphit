#!/usr/bin/env tsx
/**
 * fee-method-enum-frozen-smoke.
 *
 * The frozen fee_method rule (2026-05-13) declared a hard invariant:
 *
 *   Listing fees can ONLY be paid in BLURT, XMR, or BTC.
 *   New tradable assets (USDT, ARRR, etc.) are peer-to-peer
 *   trading only.  The indexer's `fee_method` enum stays
 *   frozen: `'blurt' | 'waived_first_buy' | 'btc' | 'xmr'`.
 *
 * This smoke is a sentinel that fails LOUDLY if anyone in the
 * future tries to expand the enum (adding 'usdt', 'ltc', etc.).
 * The asset-registry-smoke catches the registry side
 * (canPayListingFee: true must imply ticker ∈ {BLURT,BTC,XMR});
 * THIS smoke catches the wire-format side (the indexer's order
 * handler hardcodes the union type).
 *
 * Belt + suspenders: a future contributor would have to update
 * BOTH the registry AND this smoke AND the indexer order handler
 * to add a new fee_method, which is exactly the friction we
 * want — the invariant is documented in three places and any
 * of them being inconsistent triggers a CI failure.
 *
 * BEHAVIOURAL: the real indexer order handler is given an order paying its
 * fee in each method — the four frozen ones and every other registered
 * ticker — and must refuse exactly the others with `fee_method_unknown`.
 * The registry side: the fee-payable assets are exactly BLURT, BTC, XMR.
 * (It used to grep order.ts for the type union, which a rename or a
 * reformat broke while the behaviour stayed right, and the reverse.)
 *
 * Usage:
 *   tsx packages/asset-registry/scripts/fee-method-enum-frozen-smoke.ts
 */

import { ASSET_TICKERS, feePayable } from '../src/index.ts';
import handle from '../../../apps/indexer/src/indexer/handlers/order.ts';

let failed = 0;
let passed = 0;

function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── fee-method-enum-frozen smoke ────────────────────────\n');

const FROZEN = ['blurt', 'waived_first_buy', 'btc', 'xmr'];

/** The handler's verdict on an otherwise valid order paying by `method`.
 *  Validation runs before the handler touches the database or the config,
 *  so a throw after it means the method passed validation. */
async function verdict(method: string): Promise<string> {
	const ctx = {
		payload: {
			permlink: 'sell-btc-eur-2026-04',
			side: 'sell',
			asset: 'BTC',
			fiat_currency: 'EUR',
			amount_min: 50,
			amount_max: 5000,
			price_model: { kind: 'spread', percent: 1 },
			payment_methods: ['sepa'],
			fee_method: method
		},
		blockTime: new Date('2026-10-01T00:00:00Z')
	};
	try {
		const r = (await handle(ctx as never, {} as never)) as { ok: boolean; reason?: string };
		return r.ok ? 'ok' : (r.reason ?? 'refused');
	} catch {
		return 'passed_validation';
	}
}

const others = ASSET_TICKERS.map((t) => t.toLowerCase()).filter((t) => !FROZEN.includes(t));
for (const method of [...others, 'usdt-erc20', 'BLURT', '']) {
	const v = await verdict(method);
	if (v === 'fee_method_unknown') pass(`refuses fee_method '${method}'`);
	else fail(`refuses fee_method '${method}'`, `handler answered ${v}`);
}
for (const method of FROZEN) {
	const v = await verdict(method);
	if (v !== 'fee_method_unknown') pass(`accepts the method '${method}' (verdict: ${v})`);
	else fail(`accepts the method '${method}'`, 'refused as unknown');
}
const payable = feePayable()
	.map((a) => a.ticker)
	.sort();
if (JSON.stringify(payable) === JSON.stringify(['BLURT', 'BTC', 'XMR'])) {
	pass('the registry says only BLURT, BTC and XMR pay listing fees');
} else {
	fail('the registry says only BLURT, BTC and XMR pay listing fees', `feePayable() = ${payable.join(',')}`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nfee-method-enum-frozen smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally
console.log(`✓ all ${total} fee-method-enum-frozen scenarios passed`);
