/**
 * order-fee-active-auth-smoke (cp407)
 *
 * Regression guard for the BLURT-fee broadcast fix.
 *
 * The fee-bearing ops (order-create, feature-bid, stranger-fee) put a
 * `custom_json` and a `transfer` in ONE transaction. Blurt (Graphene) rejects
 * any tx that mixes posting-level and active-level operations — it asserts
 * `required_active.size() == 0` when a posting op is present. The transfer is
 * active-level, so the WHOLE tx (and thus the order custom_json) MUST be
 * active-level, signed with the active key alone.
 *
 * The original code built the order op with `required_posting_auths` and signed
 * with BOTH posting + active keys → every BLURT-paid order/bid/stranger-fee was
 * rejected by the chain. This smoke locks in the fix at the source level so a
 * future edit can't silently reintroduce the mixed-authority tx:
 *
 *   1. prepareUnsignedOrderWithFee builds the custom_json with
 *      `required_auths: [blurtAccount]` (active), NOT `required_posting_auths`.
 *   2. signOrderWithFeeWithKey takes ONLY the active key (no posting arg), so
 *      it appends exactly one active signature (an extra posting sig would be
 *      an irrelevant signature the chain can reject).
 *
 * The indexer's matching side (extractSigner accepting active-auth for exactly
 * these op ids) is covered by apps/indexer/test/blurt/verify.test.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const signPath = join(here, '..', 'src', 'lib', 'blurt', 'sign.ts');
const src = readFileSync(signPath, 'utf8');

let failures = 0;
let scenarios = 0;
function check(name: string, cond: boolean): void {
	scenarios++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		console.error(`  \u2717 ${name}`);
		failures++;
	}
}

// Isolate the prepareUnsignedOrderWithFee body so we only inspect the
// fee-bearing tx builder (the single-op broadcastCustomJson path stays posting).
const prepStart = src.indexOf('export async function prepareUnsignedOrderWithFee');
const prepEnd = src.indexOf('\nexport ', prepStart + 1);
const prepBody = prepStart >= 0 ? src.slice(prepStart, prepEnd > 0 ? prepEnd : undefined) : '';

check('prepareUnsignedOrderWithFee exists', prepStart >= 0);
check(
	'order custom_json is ACTIVE-level (required_auths: [blurtAccount])',
	/required_auths:\s*\[\s*blurtAccount\s*\]/.test(prepBody)
);
check(
	'order custom_json is NOT posting-level (would remix posting+active → chain reject)',
	!/required_posting_auths:\s*\[\s*blurtAccount\s*\]/.test(prepBody) &&
		/required_posting_auths:\s*\[\s*\]/.test(prepBody)
);
check('the fee-bearing tx still carries a transfer op', /'transfer'/.test(prepBody));

// signOrderWithFeeWithKey must sign with the active key ONLY (2 params: tx +
// activePriv). A postingPriv param means the old dual-signing is back.
const signStart = src.indexOf('export function signOrderWithFeeWithKey');
const signSig = signStart >= 0 ? src.slice(signStart, src.indexOf(')', signStart) + 1) : '';
check('signOrderWithFeeWithKey exists', signStart >= 0);
check('signOrderWithFeeWithKey takes activePriv', /activePriv:\s*Uint8Array/.test(signSig));
check(
	'signOrderWithFeeWithKey does NOT take a posting key (no dual-signing)',
	!/postingPriv/.test(signSig)
);

console.log('\u2500'.repeat(60));
if (failures > 0) {
	console.error(`\u2717 ${failures}/${scenarios} order-fee-active-auth checks failed`);
	process.exit(1);
}
console.log(`\u2713 all ${scenarios} order-fee-active-auth checks pass`);
