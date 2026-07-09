#!/usr/bin/env tsx
/**
 * Smoke: t.txt tasks #24, #25, #26 — the chat "Pay now" money path (Ken).
 *
 *  #25 A BLURT transfer is signed with the ACTIVE key. An account imported
 *      posting-only has no active key on this device, so the transfer can never
 *      be signed. The wallet's Send button was gated on exactly this
 *      (`MyBalanceCard`: `{#if hasActiveKey}`); the chat's Pay now was not — the
 *      user picked an amount, typed a password, and only then hit
 *      "useJitKey: this account was imported posting-only".
 *
 *  #24 The Pay button was disabled ONLY while a payment was in flight — it sat
 *      enabled over an empty password and an unvalidated amount. And
 *      `formatBlurtAmount` serialises with `toFixed(3)`, which ROUNDS: `1.0006`
 *      would broadcast `1.001`, `0.0004` would build `0.000 BLURT`.
 *
 *  #26 BLURT is broadcast by the app (active key). Every other asset is paid
 *      externally and only RECORDED here (amount + txid, signed with the posting
 *      key) — so FundsSentModal must NOT demand an active key.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
const loc = (c: string) =>
	JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${c}.json`), 'utf8'));

const pay = readFileSync(join(WEB, 'src', 'lib', 'components', 'PayBlurtModal.svelte'), 'utf8');
const wallet = readFileSync(join(WEB, 'src', 'lib', 'components', 'MyBalanceCard.svelte'), 'utf8');
const funds = readFileSync(join(WEB, 'src', 'lib', 'components', 'FundsSentModal.svelte'), 'utf8');
const convo = readFileSync(join(WEB, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8');
const validation = readFileSync(join(WEB, 'src', 'lib', 'blurt', 'sendValidation.ts'), 'utf8');

/** Match against CODE, not prose: docblocks quote the bugs they fixed. */
const code = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// ─── #25 active-key gate ─────────────────────────────────────────────
// tt.txt #11 — capability, not provenance. A 'posting-active' session HAS an
// active key and must be allowed to spend; `origin === 'morphit-seed'` would
// wrongly deny it. Pinned in both places so they can't drift apart again.
check('PayBlurtModal derives hasActiveKey from the KEY, not the origin', /activePublicKey \?\? null\) !== null/.test(pay));
check('it uses the SAME rule the wallet Send button uses', /activePublicKey \?\? null\) !== null/.test(wallet));
check('canPay requires an active key', /canPay = \$derived\([\s\S]{0,220}hasActiveKey/.test(code(pay)));
check('a posting-only session never sees the password field', /\{:else if !hasActiveKey\}/.test(pay));
// tt.txt #11 — the dead-end panel became an in-place unlock that RESUMES the
// payment: an existing Blurt user has no seed and no Keyfile, only an Active key
// (WIF) or a pre-fork master password.
check('…and is offered an in-place unlock instead of a dead end', /<UnlockActiveKeyModal/.test(pay));
check('the unlock CTA stays disabled while the amount is invalid', /canProceed=\{amountValid\}/.test(pay));
check('the unlocked key signs and is WIPED, never stored', /sodium\.memzero\(activeScalar\)/.test(pay) && !/persistentKeystore/.test(pay));
check('the payment resumes with the amount already typed', /function payWithEphemeralActiveKey/.test(pay) && /onUnlocked=\{payWithEphemeralActiveKey\}/.test(pay));
check('the Pay-now button is NOT hidden (the user learns why, not that it vanished)', !/showPayNowButton && hasActiveKey/.test(convo));

// ─── #24 password + amount validation ────────────────────────────────
check('canPay requires a non-empty password', /passwordFilled/.test(code(pay)) && /canPay = \$derived\([\s\S]{0,240}passwordFilled/.test(code(pay)));
check('the Pay button is disabled unless canPay', /disabled=\{!canPay \|\| phase\.kind === 'paying'\}/.test(pay));
check('typed amounts go through the shared validator', /validateBlurtAmount\(enteredAmount, Number\.POSITIVE_INFINITY\)/.test(pay));
check('pill-supplied amounts are checked against the 3-decimal grid too', /hasBlurtPrecision\(amount\)/.test(pay));
check('hasBlurtPrecision exists and tolerates float error', /export function hasBlurtPrecision/.test(validation) && /1e-6/.test(validation));
check('a precision error has its own message', /chat\.pay_blurt\.error_amount_precision/.test(pay));
check('the amount error keys off the AMOUNT, not canPay', !/enteredAmount\.trim\(\)\.length > 0 && !canPay/.test(pay));

// ─── #24 label honesty ───────────────────────────────────────────────
check('the password label names the account and the active key', loc('en').chat.pay_blurt.password_label === 'Your @{account} password (to sign with your active key)');
check('the label matches the wallet modal\u2019s wording', loc('en').profile.wallet.password_label === loc('en').chat.pay_blurt.password_label);
check('the label is interpolated with the signed-in account', /password_label', \{ values: \{ account: myAccount \?\? '' \} \}/.test(pay));
check('the hint still says a raw key is never pasted', /never paste a raw key here/.test(loc('en').chat.pay_blurt.password_hint));

// ─── #26 BTC/XMR path ────────────────────────────────────────────────
check('BLURT routes to PayBlurtModal, everything else to FundsSentModal', /composerPayNowAsset === 'blurt'/.test(convo) && /showFundsSentModal = true;/.test(convo));
check('FundsSentModal needs NO active key (external payment, posting-key record)', !/runWithActiveKey/.test(funds));
check('the recorded payment still requires a txid', /txid/.test(funds));

// ─── locales ─────────────────────────────────────────────────────────
check('all 10 locales carry the changed pay strings', LOCALES.every((c) => {
	const pb = loc(c).chat.pay_blurt;
	return typeof pb.error_amount_precision === 'string' && String(pb.password_label).includes('{account}');
}));
check('all 10 locales carry the unlock_active namespace', LOCALES.every((c) => {
	const u = loc(c).unlock_active;
	return (
		typeof u?.title === 'string' &&
		String(u.body).includes('{account}') &&
		typeof u.error?.is_owner_key === 'string' &&
		typeof u.error?.is_posting_key === 'string'
	);
}));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} pay-now-active-key scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} pay-now-active-key checks FAILED`);
	process.exit(1);
}
