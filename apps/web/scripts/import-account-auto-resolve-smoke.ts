/**
 * import-account-auto-resolve-smoke (cp354)
 *
 * Pins the invariant that a successful import NEVER forces the user to type
 * their Blurt account name by hand — for ANY of the three import methods.
 * The account name isn't carried by a seed, a keyfile, or a bare posting key,
 * so each path reverse-resolves it from the derived POSTING public key via the
 * same-origin `get_key_references` proxy (accountByKey → /v1/chain/key-references,
 * pinned same-origin by rpc-privacy-routing-smoke). A unique match is
 * authoritative (the key is in exactly that account's posting authority);
 * ambiguity / no-match / RPC-miss falls back to manual entry.
 *
 * Regressions this guards against:
 *   - the seed/keyfile path reading the pubkey from `full` (seed-only) again,
 *     so keyfile silently falls through to manual /settings entry;
 *   - the posting-only handler going back to a REQUIRED account field (the
 *     pre-cp354 `!postingAccount.trim()` submit gate + up-front mandatory
 *     validation) instead of auto-detecting from the key;
 *   - the could_not_resolve fallback message disappearing.
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
check(
	'seed/keyfile path does NOT gate the pubkey capture on the seed-only `full` again',
	!/pendingPubKeysBLT = \[await formatPublicKeyBLT\(full\.keys\.posting\.publicKey\)\]/.test(
		importPage
	)
);
check(
	'the captured pubkey feeds the reverse lookup (resolveAccountsByPublicKeys)',
	/resolveAccountsByPublicKeys\(pendingPubKeysBLT\)/.test(importPage)
);

// ─── posting-only: account is OPTIONAL, auto-detected from the key ───────────
check(
	'posting-only treats the account as optional (typedAccount, not a mandatory `account`)',
	/const typedAccount = postingAccount\.trim\(\)\.toLowerCase\(\)/.test(importPage) &&
		/if \(typedAccount && !BLURT_ACCOUNT_RE\.test\(typedAccount\)\)/.test(importPage)
);
check(
	'posting-only reverse-resolves the account from the derived key when blank',
	/if \(!account\)/.test(importPage) &&
		/resolveAccountsByPublicKeys\(\[derivedPub\]\)/.test(importPage)
);
check(
	'posting-only submit button NO LONGER requires a typed account name',
	!/!postingAccount\.trim\(\) \|\|/.test(importPage)
);
check(
	'blank-account auto-detect failure falls back to a manual-entry message',
	/posting_only\.error\.could_not_resolve/.test(importPage)
);

// ─── the fallback i18n key exists ────────────────────────────────────────────
check(
	'en locale carries posting_only.error.could_not_resolve',
	typeof enLocale?.onboarding?.import?.posting_only?.error?.could_not_resolve === 'string' &&
		enLocale.onboarding.import.posting_only.error.could_not_resolve.length > 0
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} import-account-auto-resolve scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
