/**
 * fee-split-smoke (cp408) — HIGH/CRITICAL regression for the payment-time
 * federation revenue split.
 *
 * Money routing: on a FEDERATION instance a BLURT listing/feature/stranger fee
 * splits AT PAYMENT TIME into 90% to the instance owner + 10% to the canonical
 * treasury; on the CANONICAL instance (or when a federation owner's account is
 * blank/invalid and falls back to canonical) it collapses to a single 100%
 * transfer to the canonical treasury. This is the mechanism that (a) pays
 * federation owners their 90% directly and (b) guarantees the canonical
 * treasury its 10% of every federation instance's BLURT fees.
 *
 * This smoke locks in that the frontend builder `feeTransfersFor` always
 * produces legs the INDEXER will accept. It re-encodes the indexer's acceptance
 * rule (apps/indexer/src/indexer/fee.ts `canonicalShareOk`) here as the
 * contract, so a drift on either side is caught:
 *   - legs sum (in milliBLURT) to the ceil-rounded total the user pays;
 *   - the canonical treasury receives >= 10% × (1 − split tolerance) of total;
 *   - federation → exactly 2 legs (owner + canonical); canonical → exactly 1;
 *   - every amount is a Graphene-valid "N.NNN BLURT" string;
 *   - the canonical leg is NEVER skipped on a federation instance.
 *
 * Usage:
 *   tsx apps/web/scripts/fee-split-smoke.ts
 */

import { computeFee, feeTransfersFor, FEE_RECIPIENT, type FeeTransfer } from '../src/lib/orders/fee.ts';
import { boundedBlurtBase } from '../src/lib/orders/feeQuoteFloor.ts';
import {
	sumFeeTransfers,
	meetsMinimumMilli,
	expectedFeeBlurt,
	canonicalShareOk
} from '../../indexer/src/indexer/fee.ts';
import { FEE_PRICE_TOLERANCE } from '@morphit/asset-registry';
import { FEE_TREASURY_SHARE_BLURT } from '@morphit/asset-registry';

// Must match the indexer's FEE_SPLIT_TOLERANCE (apps/indexer/src/indexer/fee.ts).
// If the indexer's changes, change here too — the smoke is the cross-side pin.
const INDEXER_SPLIT_TOLERANCE = 0.02;

const CANON = FEE_RECIPIENT; // 'morphit-fees'
const OWNER = 'community-op';

let failures = 0;
let scenarios = 0;
function check(name: string, cond: boolean, detail = ''): void {
	scenarios++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		console.error(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`);
		failures++;
	}
}

const AMOUNT_RE = /^\d+\.\d{3} BLURT$/;
function milli(amountStr: string): number {
	return Math.round(Number(amountStr.replace(' BLURT', '')) * 1000);
}
function sumMilli(legs: FeeTransfer[]): number {
	return legs.reduce((s, l) => s + milli(l.amount), 0);
}

// Realistic + edge fee sizes (BLURT). Real fees are ~40-300 BLURT (USD-targeted).
const FEES = [0.125, 1, 12.5, 40, 54.001, 60, 75.4271, 123.456, 300, 999.999];

// ─── v1.20.0 (G8): a quote clamped onto the chain-pinned floor must VERIFY ──
// When BLURT rises past the tolerance band the post page clamps its quote to
// pinned × (1 − FEE_PRICE_TOLERANCE). Round-trip every such payment through
// the REAL indexer code (sumFeeTransfers + the milliBLURT floor check): the
// old float sum/compare rejected ~0.2% of pins as underpaid.
{
	let rejected = 0;
	let tried = 0;
	let example = '';
	for (let p = 1000; p <= 130000; p += 7) {
		const pinned = p / 1000;
		for (const nth of [1, 4, 11]) {
			for (const owner of [OWNER, CANON]) {
				tried++;
				const base = boundedBlurtBase(0.0001, 60, pinned);
				const q = computeFee(nth, base);
				const legs = feeTransfersFor(q.blurtAmount, owner, CANON, 'alice');
				const ops = legs.map(
					(l) => ['transfer', { from: 'alice', to: l.to, amount: l.amount, memo: 'm' }] as const
				);
				const fee = sumFeeTransfers(ops, 'alice', owner, CANON, 'm');
				const min = expectedFeeBlurt(nth, pinned) * (1 - FEE_PRICE_TOLERANCE);
				const ok =
					fee !== null &&
					meetsMinimumMilli(fee.totalMilli, min) &&
					canonicalShareOk(fee.totalBlurt, fee.toCanonicalBlurt);
				if (!ok) {
					rejected++;
					if (!example) example = `pinned=${pinned} nth=${nth} legs=${legs.map((l) => l.amount).join('+')}`;
				}
			}
		}
	}
	check(`clamped-to-floor quotes verify at the indexer (${tried} pins × tiers × recipients)`, rejected === 0, `${rejected} rejected, e.g. ${example}`);
}

// ─── Federation instance: owner ≠ canonical → 90/10 split ─────────────
for (const fee of FEES) {
	const legs = feeTransfersFor(fee, OWNER, CANON);
	const totalMilli = Math.ceil(fee * 1000);
	const canonLeg = legs.find((l) => l.to === CANON);
	const ownerLeg = legs.find((l) => l.to === OWNER);
	const toCanonMilli = canonLeg ? milli(canonLeg.amount) : 0;
	const requiredCanonMilli = totalMilli * FEE_TREASURY_SHARE_BLURT * (1 - INDEXER_SPLIT_TOLERANCE);

	check(`federation fee ${fee}: exactly 2 legs (owner + canonical)`, legs.length === 2);
	check(`federation fee ${fee}: legs are valid "N.NNN BLURT"`, legs.every((l) => AMOUNT_RE.test(l.amount)));
	check(`federation fee ${fee}: legs sum to the ceil-rounded total`, sumMilli(legs) === totalMilli, `${sumMilli(legs)} vs ${totalMilli}`);
	check(`federation fee ${fee}: canonical treasury present`, !!canonLeg && !!ownerLeg);
	check(
		`federation fee ${fee}: canonical receives >= 10% (indexer canonicalShareOk passes)`,
		toCanonMilli >= requiredCanonMilli,
		`toCanon=${toCanonMilli}mB required>=${requiredCanonMilli.toFixed(1)}mB`
	);
	check(`federation fee ${fee}: no leg addressed to self/blank`, legs.every((l) => l.to && l.to !== ''));
}

// ─── Canonical instance: recipient === canonical → single 100% ───────
for (const fee of FEES) {
	const legs = feeTransfersFor(fee, CANON, CANON);
	const totalMilli = Math.ceil(fee * 1000);
	check(`canonical fee ${fee}: exactly 1 leg`, legs.length === 1);
	check(`canonical fee ${fee}: 100% to canonical treasury`, legs[0]?.to === CANON && milli(legs[0]!.amount) === totalMilli);
}

// ─── Fallback: blank/invalid owner already resolved to canonical upstream,
//     so feeTransfersFor is called with CANON and must collapse (covered above).
//     Here we assert the collapse also fires when a share would round to dust.
{
	const legs = feeTransfersFor(0.004, OWNER, CANON); // 10% rounds below milliBLURT
	check('dust fee 0.004: collapses to a single 100% canonical transfer (no zero/dust leg)', legs.length === 1 && legs[0]!.to === CANON);
}

// ─── Anti-drift: the split ratio is the shared asset-registry constant ──
check('split ratio is 10% (FEE_TREASURY_SHARE_BLURT)', FEE_TREASURY_SHARE_BLURT === 0.1);

console.log('\u2500'.repeat(60));
if (failures > 0) {
	console.error(`\u2717 ${failures}/${scenarios} fee-split checks failed`);
	process.exit(1);
}
console.log(`\u2713 all ${scenarios} fee-split checks pass`);
