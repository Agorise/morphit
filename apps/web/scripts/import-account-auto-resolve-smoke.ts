/**
 * import-account-auto-resolve-smoke
 *
 * Pins the invariant that a successful import NEVER forces the user to type
 * their Blurt account name by hand — for ANY of the three import methods.
 * The account name isn't carried by a seed, a keyfile, or a bare posting key,
 * so each path reverse-resolves it from the derived POSTING public key via the
 * same-origin `get_key_references` proxy (accountByKey → /v1/chain/key-references,
 * pinned same-origin by rpc-privacy-routing-smoke). A unique match is
 * authoritative (the key is in exactly that account's posting authority);
 * when the derived key can't map to a unique account (prefork /
 * ambiguous / no-match), the posting-only path reveals a VALIDATED manual
 * Username field (checked against the derived key in real time) instead of
 * dead-ending.
 *
 * v1.21.21 — the lookups are asked until the chain answers ($lib/auth/
 * postingKeyCheck.ts, whose unit tests drive the behaviour): a moment when the
 * network side does not answer is no longer read as "no account has this key".
 * So the old red could_not_resolve message is gone — "no single account" now
 * just shows the Username field with its own hint.
 *
 * Regressions this guards against:
 *   - the seed/keyfile path reading the pubkey from `full` (seed-only) again,
 *     so keyfile silently falls through to manual /settings entry;
 *   - the posting-only path losing its auto-resolve (unique key → account, no
 *     typing) — the common case must never force manual entry;
 *   - the prefork fallback regressing: the validated manual field, its
 *     real-time key-check, or the manual_account_* strings disappearing.
 *
 * Static source scan (the page pulls $-aliases the bare runner can't resolve,
 * so we assert on source text rather than importing the component).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const importPage = readFileSync(
	join(webRoot, 'src/routes/[lang]/onboarding/import/+page.svelte'),
	'utf8'
);
const enLocale = JSON.parse(readFileSync(join(webRoot, 'src/lib/i18n/locales/en.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${label}`);
	} else {
		failed++;
		console.log(`  \u2717 ${label}`);
	}
}

console.log('\nimport-account-auto-resolve smoke:\n');

// ─── seed + keyfile: capture the posting pubkey from the BOOTED session ──────
// Reading it off the live identity (not `full`) is what makes KEYFILE resolve
// too — the keyfile envelope decrypts inside bootFromEnvelope without ever
// surfacing a FullIdentity to the page.
check(
	'seed/keyfile path reads the posting pubkey from the booted live identity (get(liveIdentity))',
	/get\(liveIdentity\)/.test(importPage) &&
		/formatPublicKeyBLT\(\s*booted\.posting\.publicKey\s*\)/.test(importPage)
);
// v1.16.9 — the WIF field must resist Firefox's on-load autofill (which ignores
// autocomplete="off" on password fields and dumps a saved site password in).
// v1.21.14 — `readonly` + use:keyField, so EVERY render of the field starts locked
// (the old one-way wifFieldLocked flag left it writable after a tab switch, and
// Firefox filled it). password-field-scope-smoke holds the rule for all key fields.
const wifTag = /<input\b(?:(?!\/>)[\s\S])*?name="morphit-posting-wif-import"(?:(?!\/>)[\s\S])*?\/>/.exec(
	importPage
)?.[0] ?? '';
check(
	'WIF field starts read-only on every render (`readonly` + use:keyField) to dodge Firefox autofill',
	/^\s*readonly\s*$/m.test(wifTag) && /use:keyField/.test(wifTag) && !/wifFieldLocked/.test(importPage)
);
check(
	'WIF field has a unique, non-credential name/id (not matched to a saved login)',
	/name="morphit-posting-wif-import"/.test(importPage)
);
check(
	'seed/keyfile path does NOT gate the pubkey capture on the seed-only `full` again',
	!/pendingPubKeysBLT = \[await formatPublicKeyBLT\(full\.keys\.posting\.publicKey\)\]/.test(
		importPage
	)
);
check(
	'the captured pubkey feeds the (patient) reverse lookup',
	/lookupAccountsPatiently\(pendingPubKeysBLT,/.test(importPage)
);

// ─── posting-only: auto-resolve when unique; a later change reveals a validated ───────
//     manual Username field when the key can't map to a unique account.
check(
	'posting-only does NOT reintroduce the old cp406 postingAccount field',
	!/postingAccount/.test(importPage)
);
check(
	'posting-only auto-resolves the account from the derived posting key (unique match, no typing)',
	/startKeyCheck\(pub, null\)/.test(importPage) &&
		/case 'ok':\s*detectedAccount = r\.account;/.test(importPage)
);
check(
	'cp434: an unresolvable key (prefork/ambiguous/no-match) reveals the manual field',
	/accountFieldNeeded = true/.test(importPage)
);
check(
	'cp434: the manual account is validated against the derived key in real time',
	/async function validateManualAccount/.test(importPage) &&
		/startKeyCheck\(derivedPubCache, name\)/.test(importPage) &&
		/manualAccountStatus = r\.kind === 'ok' \? 'valid' : 'invalid'/.test(importPage)
);
// v1.21.21 — the button joins the PATIENT check, and the page asks with the
// lookup that can say "unavailable". A direct fetchAccountKeys / verify on
// submit, or resolveAccountsByPublicKeys (which turns a failure into "no
// account"), brings back the red "Something unexpected went wrong" / "couldn't
// detect your account" for a network moment (@classx on vigilante).
{
	const unlockBody = importPage.slice(
		importPage.indexOf('async function unlockPostingOnly'),
		importPage.indexOf('async function unlock(): Promise<void>')
	);
	check(
		'the Unlock button waits on the patient key check (startKeyCheck … await run.result)',
		/const run = startKeyCheck\(derivedPub, typedAccount\);/.test(unlockBody) &&
			/verdict = await run\.result;/.test(unlockBody) &&
			!/fetchAccountKeys\(/.test(unlockBody) &&
			!/verifyPostingKey\(/.test(unlockBody)
	);
	check(
		'the check is the patient one, fed by the lookup that reports "unavailable"',
		/checkPostingKeyPatiently\(pub, account,/.test(importPage) &&
			/lookup: lookupAccountsByPublicKeys,/.test(importPage) &&
			!/resolveAccountsByPublicKeys/.test(importPage)
	);
	check(
		'a stopped check ends quietly (no red when the person pressed Stop)',
		/if \(run\.ctrl\.signal\.aborted\) return;/.test(unlockBody)
	);
}
check(
	'cp434: submit gates on the manual account ONLY when the field is shown',
	/accountFieldNeeded && manualAccountStatus !== 'valid'/.test(importPage)
);
check(
	'no single account for the key shows the Username field, not a red error',
	/if \(verdict\.kind === 'needs-account-name'\) \{\s*(?:\/\/[^\n]*\n\s*)*accountFieldNeeded = true;/.test(importPage) &&
		!/posting_only\.error\.could_not_resolve/.test(importPage)
);

// ─── the one gate before the key is kept (v1.21.21 deep review) ─────────────
// The posting-key path keeps the key (encryptIdentity) only for an account
// accountToSignIn returns — an 'ok' for exactly this key and typed name. The
// verdict branches above it show messages; this is what keeps an Active or
// Owner key off the device if one of them is ever missed. (accountToSignIn
// itself: postingKeyCheck.test.ts.)
{
	const start = importPage.indexOf('async function unlockPostingOnly(');
	const end = importPage.indexOf('\n\tasync function ', start + 1);
	const body = start < 0 ? '' : importPage.slice(start, end < 0 ? undefined : end);
	const gate = body.search(/const account = accountToSignIn\(verdict, run, \{/);
	const refuse = body.search(/if \(account === null\) return;/);
	const keep = body.indexOf('encryptIdentity(');
	check(
		`v1.21.21: the posting-key sign-in keeps the key only after accountToSignIn approved it (gate ${gate}, refuse ${refuse}, keep ${keep})`,
		gate > 0 && refuse > gate && keep > refuse && !/verdict\.account/.test(body.slice(refuse))
	);
	check(
		'v1.21.21: the password kept is the one checked, not the field as it is when the network answers',
		/const password = postingNewPassword;/.test(body) && /encryptIdentity\(full, password\)/.test(body)
	);
}

// ─── the i18n keys exist ─────────────────────────────────────────────────────
check(
	'v1.21.21: en locale carries the calm "still checking your key" strings',
	['checking_key', 'checking_key_slow', 'checking_key_button', 'waiting_title', 'waiting_body', 'waiting_stop'].every(
		(k) =>
			typeof enLocale?.onboarding?.import?.posting_only?.[k] === 'string' &&
			enLocale.onboarding.import.posting_only[k].length > 0
	)
);
check(
	'cp434: en locale carries the manual_account_* keys',
	[
		'manual_account_label',
		'manual_account_placeholder',
		'manual_account_hint',
		'manual_account_hint_slow',
		'manual_account_invalid'
	].every(
		(k) =>
			typeof enLocale?.onboarding?.import?.posting_only?.[k] === 'string' &&
			enLocale.onboarding.import.posting_only[k].length > 0
	)
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} import-account-auto-resolve scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
