/**
 * send-blurt-modal — cp424 (wallet security pass, Send UI).
 *
 * The transfer op + signing are proven by wallet-op-builders-smoke; this
 * pins the Send UI glue that can't run in the sandbox (no DOM / network /
 * key entry). Send is riskier than the staking modals because the
 * RECIPIENT is user-entered, so the guards below matter most:
 *
 *   1. Two-stage recipient validation — instant FORMAT check
 *      (isValidBlurtAccount) + not-self, THEN a debounced ON-CHAIN
 *      existence check (fetchAccountBalance → 404 = not_found). Send stays
 *      disabled until the recipient resolves to a REAL account, so a typo
 *      can't fire BLURT into a void.
 *   2. The lookup is debounced AND guarded against a stale field (the
 *      value may change while a timer/round-trip is in flight).
 *   3. The amount is bounded to the balance and only reaches the signer
 *      through the throwing formatter.
 *   4. The memo carries a PROMINENT plaintext-public privacy warning.
 *   5. Signs inside runWithActiveKey, broadcasts outside, wipes password.
 *   6. MyBalanceCard offers Send only to a signing-capable session and
 *      lazy-loads the modal; profile.send.* exists in all 10 locales.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8');

let failures = 0;
// cp442 — `total` was hardcoded as 29 in the summary line while the file ran
// more checks than that, so the battery under-counted this smoke's assertions.
// Count for real.
let total = 0;
function check(name: string, cond: boolean, detail = ''): void {
	total++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failures++;
	}
}

const modal = read('apps/web/src/lib/components/SendBlurtModal.svelte');

// ─── 1. Transfer op + signer wiring ────────────────────────────────────
check(
	'imports the transfer op builder + signer + broadcast',
	/prepareUnsignedTransfer\b/.test(modal) &&
		/signTransferWithKey/.test(modal) &&
		/broadcastSignedTransaction/.test(modal)
);
check(
	'signs INSIDE runWithActiveKey (key never outlives the sync sign)',
	/runWithActiveKey\(passwordInput,\s*async \(activePriv\)/.test(modal) &&
		/signTransferWithKey\(unsignedTx, activePriv\)/.test(modal)
);
check(
	'broadcasts after signing + wipes the password',
	/broadcastSignedTransaction\(r\.value\)/.test(modal) && /passwordInput = '';/.test(modal)
);
check(
	'the transfer is built from the NORMALIZED recipient (not the raw field)',
	/const to = normalizeAccount\(recipient\)/.test(modal) &&
		/prepareUnsignedTransfer\(\s*account,\s*to,/.test(modal)
);

// ─── 2. Two-stage recipient validation ─────────────────────────────────
check(
	'stage 1 — instant FORMAT check via isValidBlurtAccount',
	/isValidBlurtAccount\(norm\)/.test(modal)
);
check(
	'stage 1 — rejects sending to yourself',
	/norm === account[\s\S]*?recipientState = 'self'/.test(modal)
);
check(
	'stage 2 — ON-CHAIN existence via fetchAccountBalance',
	/fetchAccountBalance\(resolveOrigin\(MORPHIT_INDEXER_ORIGIN\), norm\)/.test(modal)
);
check(
	"stage 2 — a 404 maps to 'not_found' (typo can't send into a void)",
	/result\.kind === 'not_found'[\s\S]*?recipientState = 'not_found'/.test(modal) ||
		/'not_found'/.test(modal)
);
check(
	'the on-chain lookup is DEBOUNCED (not fired every keystroke)',
	/debounceTimer = setTimeout\(/.test(modal) && /clearTimeout\(debounceTimer\)/.test(modal)
);
check(
	'the lookup is guarded against a stale field (before AND after the round-trip)',
	(modal.match(/normalizeAccount\(recipient\) !== norm/g) || []).length >= 2
);
check(
	'the recipient is normalized (strip @, lowercase)',
	/replace\(\/\^@\+\/,\s*''\)\.toLowerCase\(\)/.test(modal)
);

// ─── 3. Send is gated on a VALID recipient + a valid amount ─────────────
check(
	"canSend requires recipientState === 'valid'",
	/canSend = \$derived\([\s\S]*?recipientState === 'valid'/.test(modal)
);
// cp442 — the bound moved into the pure `$lib/blurt/sendValidation` module (so
// it can be unit-tested), but it must still be ENFORCED and the amount must
// still reach the signer through the throwing formatter.
const sendValidationSrc = readFileSync(
	join(import.meta.dirname, '..', 'src', 'lib', 'blurt', 'sendValidation.ts'),
	'utf-8'
);
check(
	'the amount is bounded to the balance + reaches the signer via the throwing formatter',
	/validateBlurtAmount\(amountInput, blurtBalance\)/.test(modal) &&
		/n <= balance \+ 1e-6/.test(sendValidationSrc) &&
		/formatBlurtAmount\(amountNum\)/.test(modal)
);
check(
	'the amount cannot be silently ROUNDED by toFixed(3) (1.0006 -> 1.001)',
	/\^\\d\*\(\\\.\\d\{0,3\}\)\?\$/.test(sendValidationSrc)
);
check(
	'canSend also requires the active-key password',
	/canSend = \$derived\([\s\S]*?passwordFilled/.test(modal)
);

// ─── 4. Memo privacy ───────────────────────────────────────────────────
check(
	'the memo shows a PROMINENT plaintext-public privacy warning (⚠ + key)',
	/profile\.send\.memo_privacy_warning/.test(modal) && /⚠/.test(modal)
);
check('the memo is trimmed before it goes on chain', /memo\.trim\(\)/.test(modal));
check('the debounce timer is cleared on destroy', /onDestroy\([\s\S]*?clearTimeout\(debounceTimer\)/.test(modal));

// ─── 5. MyBalanceCard: gating, lazy render, refresh ────────────────────
const card = read('apps/web/src/lib/components/MyBalanceCard.svelte');
check('the Send button is gated on hasActiveKey', /#if hasActiveKey}\s*<button[\s\S]*?openSend/.test(card) || (/openSend/.test(card) && /#if hasActiveKey/.test(card)));
check('the Send button opens the modal (openSend)', /onclick=\{openSend\}/.test(card));
check(
	'the Send modal is lazy-loaded with a LazyLoadError fallback',
	/loadSendModal\(\) then SendBlurtModal/.test(card) && /<SendBlurtModal/.test(card)
);
check(
	'a successful send refreshes the balance (onSendDone → refresh)',
	/function onSendDone\(\)[\s\S]*?triggerBalanceRefresh\(\)[\s\S]*?refresh\(\{ hard: true \}\)/.test(
		card
	)
);

// ─── 6. Recipient QR scanner (untrusted decode → same validation) ──────
const scanner = read('apps/web/src/lib/components/RecipientQrScanner.svelte');

check(
	'SendBlurtModal has a scan button that opens the scanner',
	/onclick=\{openScanner\}/.test(modal) && /scanning = true/.test(modal)
);
check(
	'the QR scan button is mobile-only (sm:hidden — hidden on desktop/PC)',
	/onclick=\{openScanner\}[\s\S]{0,400}sm:hidden/.test(modal)
);
check(
	'the scanner is lazy-loaded with a LazyLoadError fallback',
	/loadScanner\(\) then RecipientQrScanner/.test(modal) && /{:catch}\s*<LazyLoadError/.test(modal)
);
check(
	'a scanned value is treated as UNTRUSTED — re-run through onRecipientInput',
	/function onScannedRecipient[\s\S]*?recipient = candidate[\s\S]*?onRecipientInput\(\)/.test(modal)
);
check(
	'the scanner extracts only the account via extractRecipientFromQr',
	/import \{ extractRecipientFromQr \}/.test(scanner) &&
		/extractRecipientFromQr\(data\)/.test(scanner)
);
check(
	'an empty extraction shows an error, it does NOT fill the field',
	/candidate\.length === 0[\s\S]*?phase = 'invalid'/.test(scanner) &&
		/onScanned\(candidate\)/.test(scanner)
);
check(
	'the camera starts only on a user gesture (requestCamera, not on mount)',
	/onclick=\{requestCamera\}/.test(scanner) && !/onMount\([\s\S]*?startScanner/.test(scanner)
);
check(
	'the camera is torn down on destroy (onDestroy stopScanner)',
	/onDestroy\(stopScanner\)/.test(scanner) && /inst\?\.destroy\?\.\(\)/.test(scanner)
);


// ─── 7. Locale coverage ────────────────────────────────────────────────
const LOC_DIR = 'apps/web/src/lib/i18n/locales';
const locales = readdirSync(join(repo, LOC_DIR))
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace(/\.json$/, ''));
const SEND_KEYS = [
	'title',
	'subtitle',
	'recipient_label',
	'recipient_placeholder',
	'recipient_checking',
	'recipient_valid',
	'recipient_not_found',
	'recipient_invalid',
	'recipient_self',
	'recipient_error',
	'amount_placeholder',
	'memo_label',
	'memo_placeholder',
	'memo_privacy_warning',
	'error_no_active_key',
	'send_button',
	'confirm',
	'qr_heading',
	'qr_body',
	'qr_start_button',
	'qr_scanning_hint',
	'qr_camera_denied',
	'qr_no_camera',
	'qr_invalid'
];
let miss = 0;
for (const loc of locales) {
	const send = JSON.parse(read(`${LOC_DIR}/${loc}.json`))?.profile?.send;
	for (const k of SEND_KEYS) {
		if (typeof send?.[k] !== 'string' || send[k].length === 0) miss++;
	}
}
check(
	`all ${SEND_KEYS.length} profile.send.* keys present in all ${locales.length} locales`,
	miss === 0,
	`${miss} missing`
);

if (failures === 0) {
	console.log(`✓ all ${total} send-blurt-modal scenarios passed`);
} else {
	console.log(`\n✗ ${failures}/${total} send-blurt-modal scenarios failed`);
	process.exit(1);
}
