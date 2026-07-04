/**
 * fee-split-math-smoke (cp408) — the shared BLURT fee split primitive.
 *
 * `splitListingFeeBlurt` is the single source of truth for the 90/10 federation
 * revenue split. BOTH the frontend (feeTransfersFor, which builds the fee tx)
 * and the indexer (computeOperatorShareBlurt audit + the canonicalShareOk
 * verification band) rely on it, so it must be exact: the two shares always sum
 * back to the input total in integer milliBLURT, with 10% to the treasury.
 *
 * Usage:
 *   tsx packages/asset-registry/scripts/fee-split-math-smoke.ts
 */

import { splitListingFeeBlurt, FEE_TREASURY_SHARE_BLURT } from '../src/index.ts';

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

check('treasury share constant is 10%', FEE_TREASURY_SHARE_BLURT === 0.1);

// Exact expected splits (integer milliBLURT round of 10%, owner = remainder).
const CASES: { total: number; owner: number; treasury: number }[] = [
	{ total: 100, owner: 90, treasury: 10 },
	{ total: 60, owner: 54, treasury: 6 },
	{ total: 0.125, owner: 0.112, treasury: 0.013 }, // round(12.5)=13 mB treasury
	{ total: 75, owner: 67.5, treasury: 7.5 },
	{ total: 40, owner: 36, treasury: 4 }
];
for (const c of CASES) {
	const r = splitListingFeeBlurt(c.total);
	check(
		`split ${c.total} → owner ${c.owner} / treasury ${c.treasury}`,
		Math.round(r.ownerShareBlurt * 1000) === Math.round(c.owner * 1000) &&
			Math.round(r.treasuryShareBlurt * 1000) === Math.round(c.treasury * 1000),
		`got owner=${r.ownerShareBlurt} treasury=${r.treasuryShareBlurt}`
	);
}

// Invariant: shares always sum back to the milliBLURT-rounded total, and the
// treasury share is within a milli of exactly 10%.
for (const total of [0.001, 0.5, 1, 12.5, 42.001, 60, 123.456, 999.999, 5000]) {
	const r = splitListingFeeBlurt(total);
	const totalMilli = Math.round(total * 1000);
	const sumMilli = Math.round(r.ownerShareBlurt * 1000) + Math.round(r.treasuryShareBlurt * 1000);
	check(`sum-invariant ${total}: owner + treasury === total (milliBLURT)`, sumMilli === totalMilli, `${sumMilli} vs ${totalMilli}`);
	const treasuryMilli = Math.round(r.treasuryShareBlurt * 1000);
	check(`treasury ${total}: within 1 mB of exact 10%`, Math.abs(treasuryMilli - totalMilli * 0.1) <= 1);
	check(`non-negative shares ${total}`, r.ownerShareBlurt >= 0 && r.treasuryShareBlurt >= 0);
}

console.log('\u2500'.repeat(60));
if (failures > 0) {
	console.error(`\u2717 ${failures}/${scenarios} fee-split-math checks failed`);
	process.exit(1);
}
console.log(`\u2713 all ${scenarios} fee-split-math checks pass`);
