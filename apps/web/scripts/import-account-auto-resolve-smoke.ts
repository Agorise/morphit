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
 * cp434: when the derived key can't map to a unique account (prefork /
 * ambiguous / no-match), the posting-only path reveals a VALIDATED manual
 * Username field (checked against the derived key in real time) instead of
 * dead-ending — the could_not_resolve message stays as a final fallback.
 *
 * Regressions this guards against:
 *   - the seed/keyfile path reading the pubkey from `full` (seed-only) again,
 *     so keyfile silently falls through to manual /settings entry;
 *   - the posting-only path losing its auto-resolve (unique key → account, no
 *     typing) — the common case must never force manual entry;
 *   - cp434's prefork fallback regressing: the validated manual field, its
 *     real-time key-check, or the manual_account_* / could_not_resolve strings
 *     disappearing.
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

// ─── posting-only: auto-resolve when unique; cp434 reveals a validated ───────
//     manual Username field when the key can't map to a unique account.
check(
	'posting-only does NOT reintroduce the old cp406 postingAccount field',
	!/postingAccount/.test(importPage)
);
check(
	'posting-only auto-resolves the account from the derived posting key (unique match, no typing)',
	/resolveAccountsByPublicKeys\(\[pub\]\)/.test(importPage) &&
		/matches\.length === 1/.test(importPage) &&
		/detectedAccount = matches\[0\]/.test(importPage)
);
check(
	'cp434: an unresolvable key (prefork/ambiguous/no-match) reveals the manual field',
	/accountFieldNeeded = true/.test(importPage)
);
check(
	'cp434: the manual account is validated against the derived key in real time',
	/async function validateManualAccount/.test(importPage) &&
		/verifyPostingKey\(fetched, derivedPubCache\)/.test(importPage) &&
		/\? 'valid' : 'invalid'/.test(importPage)
);
check(
	'cp434: submit gates on the manual account ONLY when the field is shown',
	/accountFieldNeeded && manualAccountStatus !== 'valid'/.test(importPage)
);
check(
	'could_not_resolve message survives as the final fallback',
	/posting_only\.error\.could_not_resolve/.test(importPage)
);

// ─── the i18n keys exist ─────────────────────────────────────────────────────
check(
	'en locale carries posting_only.error.could_not_resolve',
	typeof enLocale?.onboarding?.import?.posting_only?.error?.could_not_resolve === 'string' &&
		enLocale.onboarding.import.posting_only.error.could_not_resolve.length > 0
);
check(
	'cp434: en locale carries the manual_account_* keys',
	['manual_account_label', 'manual_account_placeholder', 'manual_account_hint', 'manual_account_invalid'].every(
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
