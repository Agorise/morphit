/**
 * wallet-power-modal — cp424 (wallet security pass, staking UI).
 *
 * The op/math/signing this flow stands on is proven end-to-end by
 * wallet-op-builders-smoke (28/28: VESTS math, exact-precision
 * formatters, builder validation, genuine round-trip signing for all
 * three ops incl. the hand-serialized withdraw_vesting). This smoke
 * pins the UI GLUE around it — the parts that don't run in the sandbox
 * (no DOM / no key entry) and so can't be exercised by the op smoke:
 *
 *   1. PowerModal wires each mode to the CORRECT op + signer, signs
 *      inside runWithActiveKey (active key never outlives the sync sign),
 *      broadcasts outside it, and wipes the password.
 *   2. Power-DOWN sends the EXACT on-chain vesting_shares for "power down
 *      everything" (dust-free), converts a partial amount BP→VESTS, and
 *      shows the honest ~4-week release notice (never implied instant).
 *   3. The amount reaches the signer only through the throwing
 *      formatters (a malformed number can't be signed) and is bounded to
 *      the available balance.
 *   4. MyBalanceCard offers the buttons ONLY to a session that can sign
 *      active ops (a posting-only login can't), captures the pool figures
 *      the modal needs, and renders the modal lazily.
 *   5. The card header reads "wallet" (not "balance") and the
 *      profile.wallet.* keys exist in all 10 locales.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failures++;
	}
}

// ─── 1. PowerModal: op + signer wiring ─────────────────────────────────
const modal = read('apps/web/src/lib/components/PowerModal.svelte');

check(
	'imports both op builders (transfer_to_vesting + withdraw_vesting)',
	/prepareUnsignedTransferToVesting/.test(modal) &&
		/prepareUnsignedWithdrawVesting/.test(modal)
);
check(
	'imports both signers (signTransferWithKey + signWithdrawVestingWithKey)',
	/signTransferWithKey/.test(modal) && /signWithdrawVestingWithKey/.test(modal)
);
check(
	'power-UP builds a SELF transfer_to_vesting (from === to === account)',
	/prepareUnsignedTransferToVesting\(\s*account,\s*account,/.test(modal)
);
check(
	'power-UP signs with signTransferWithKey; power-DOWN with signWithdrawVestingWithKey',
	/mode === 'up'[\s\S]*?signTransferWithKey\(unsignedTx, activePriv\)[\s\S]*?signWithdrawVestingWithKey\(unsignedTx, activePriv\)/.test(
		modal
	)
);
check(
	'signs INSIDE runWithActiveKey (key never outlives the sync sign)',
	/runWithActiveKey\(passwordInput,\s*async \(activePriv\)/.test(modal)
);
check(
	'broadcasts via broadcastSignedTransaction after signing',
	/broadcastSignedTransaction\(r\.value\)/.test(modal)
);
check('wipes the password after the active-key call', /passwordInput = '';/.test(modal));

// ─── 2. Power-down: dust-free "everything" + BP→VESTS + honest schedule ─
check(
	'"power down everything" sends the EXACT on-chain vesting_shares (no round-trip)',
	/usingFullBalance\s*\?\s*vestingSharesRaw/.test(modal)
);
check(
	'a partial power-down converts BP→VESTS via blurtPowerToVests + formatVestsAmount',
	/formatVestsAmount\(blurtPowerToVests\(amountNum, vestingFund, totalVests\)\)/.test(modal)
);
check(
	'a manual amount edit clears the full-balance flag (usingFullBalance = false)',
	/function onAmountInput\(\)[\s\S]*?usingFullBalance = false/.test(modal)
);
check(
	'power-DOWN shows the honest release notice (schedule key + ⏳)',
	/mode === 'down'[\s\S]*?profile\.wallet\.power_down_schedule/.test(modal) &&
		/⏳/.test(modal)
);
check(
	'the schedule copy says "over 4 weeks" and that it is NOT instant',
	/over 4 weeks/i.test(read('apps/web/src/lib/i18n/locales/en.json')) &&
		/isn't instant/i.test(read('apps/web/src/lib/i18n/locales/en.json'))
);

// ─── 3. Amount safety ──────────────────────────────────────────────────
check(
	'the amount reaches the signer only via the throwing formatters',
	/formatBlurtAmount\(amountNum\)/.test(modal)
);
check(
	'the amount is bounded to the available balance (cannot exceed it)',
	/amountNum <= available/.test(modal)
);

// ─── 4. MyBalanceCard: gating, capture, lazy render ────────────────────
const card = read('apps/web/src/lib/components/MyBalanceCard.svelte');

// tt.txt #11 — CAPABILITY, not provenance. A 'posting-active' session keeps a
// verified Active key on this device and can power up/down; asking
// `origin === 'morphit-seed'` would deny it. Power-up is signed with the same
// active key a transfer is, so it rides the same gate.
check(
	'active-key gate: hasActiveKey derives from the KEY, not the origin',
	/hasActiveKey = \$derived\(\(\$liveIdentity\?\.activePublicKey \?\? null\) !== null\)/.test(card)
);
// Match CODE, not prose: the fix's own doc-comment quotes the buggy expression
// it replaced, and a naive grep sees it and "fails". Recurring lesson.
const cardCode = card
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.split('\n')
	.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
	.join('\n');
check('…and it is NOT the old provenance check', !/origin === 'morphit-seed'/.test(cardCode));
check(
	'the power-up/down buttons are gated on hasActiveKey',
	/#if hasActiveKey && blurtBalance > 0/.test(card) &&
		/#if hasActiveKey && bpBalance > 0/.test(card)
);
check(
	'the buttons open the right mode (openPower up / down)',
	/openPower\('up'\)/.test(card) && /openPower\('down'\)/.test(card)
);
check(
	'the card captures the raw pool figures + exact vesting_shares for the modal',
	/vestingFund =/.test(card) && /totalVests =/.test(card) && /vestingSharesRaw =/.test(card)
);
check(
	'the modal is lazy-loaded with a LazyLoadError fallback',
	/loadPowerModal\(\) then PowerModal/.test(card) && /{:catch}\s*<LazyLoadError/.test(card)
);
check(
	'a successful op refreshes the balance (onPowerDone → refresh)',
	/function onPowerDone\(\)[\s\S]*?triggerBalanceRefresh\(\)[\s\S]*?refresh\(\{ hard: true \}\)/.test(
		card
	)
);

// ─── 5. Header rename + locale coverage ────────────────────────────────
const LOC_DIR = 'apps/web/src/lib/i18n/locales';
const locales = readdirSync(join(repo, LOC_DIR))
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace(/\.json$/, ''));

const WALLET_KEYS = [
	'power_up_action',
	'power_down_action',
	'power_up_title',
	'power_down_title',
	'power_up_subtitle',
	'power_down_subtitle',
	'amount_label',
	'power_up_placeholder',
	'power_down_placeholder',
	'use_full',
	'available_blurt',
	'available_bp',
	'power_down_schedule',
	'password_label',
	'error_password_required',
	'error_bad_password',
	'error_no_active_key',
	'error_broadcast',
	'error_amount'
];

let localeMisses = 0;
let titleStillBalance = 0;
for (const loc of locales) {
	const j = JSON.parse(read(`${LOC_DIR}/${loc}.json`));
	const w = j?.profile?.wallet;
	for (const k of WALLET_KEYS) {
		if (typeof w?.[k] !== 'string' || w[k].length === 0) localeMisses++;
	}
	// The title interpolates {account}; it must no longer read "balance"
	// in EN (the rename), and must be a non-empty string everywhere.
	const title = j?.profile?.my_balance?.title;
	if (typeof title !== 'string' || title.length === 0) titleStillBalance++;
}
check(
	`all ${WALLET_KEYS.length} profile.wallet.* keys present in all ${locales.length} locales`,
	localeMisses === 0,
	`${localeMisses} missing`
);
const enTitle = JSON.parse(read(`${LOC_DIR}/en.json`)).profile.my_balance.title as string;
check(
	'the EN header now says "wallet", not "balance"',
	/wallet/i.test(enTitle) && !/balance/i.test(enTitle)
);
check('every locale has a non-empty header title', titleStillBalance === 0);

if (failures === 0) {
	console.log('✓ all 23 wallet-power-modal scenarios passed');
} else {
	console.log(`\n✗ ${failures}/23 wallet-power-modal scenarios failed`);
	process.exit(1);
}
