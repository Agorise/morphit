#!/usr/bin/env tsx
/**
 * Smoke: the settings page "Missing Posting Authority" bug (Ken, twice).
 *
 * The Blurt account name lived in ONE origin-wide localStorage key with a
 * `storage` listener that rewrote it whenever ANOTHER tab signed in — while the
 * keys stayed per-session in memory. Sign in as @kentest2 in one tab and
 * @kentest3 in another, and tab A signs with kentest2's posting key while
 * declaring `required_posting_auths: ["kentest3"]`. The chain rejects it and
 * dumps three authorities at a user who just wanted to set a display name.
 *
 * cp440 "fixed" this by deleting the pre-flight check, reasoning that chat
 * broadcasts worked and profile ones didn't. But chat messages travel over the
 * RELAY, not the chain — they never exercised this path. Deleting the check
 * only replaced a clear error with a chain dump.
 *
 * The rule: a signature is made by a KEY, so the account it may speak for is a
 * property of that key — never of a string another tab can overwrite.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8');
const strip = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');

const binding = read('src', 'lib', 'blurt', 'accountBinding.ts');
const sign = strip(read('src', 'lib', 'blurt', 'sign.ts'));
const profile = strip(read('src', 'lib', 'blurt', 'ops', 'profile.ts'));

let pass = 0;
let fail = 0;
// v1.7.5 — optional third arg: a failure detail, printed only when the check
// fires. The rewritten checks pass one to explain WHY a requirement holds when
// the landmark it used to key off has moved.
const check = (name: string, ok: boolean, detail?: string): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
	}
};

check('the broadcast account is resolved from the signing key', /const signingAccount = await resolveBroadcastAccount\(live, blurtAccount\);/.test(sign));
check('…and THAT is what goes into required_posting_auths', /required_posting_auths: \[signingAccount\]/.test(sign));
check('the origin-wide storage value is never used directly for auth', !/required_posting_auths: \[blurtAccount\]/.test(sign));

check('resolveBroadcastAccount derives the pubkey from the live posting key', /formatPublicKeyBLT\(live\.posting\.publicKey\)/.test(binding));
check('a wrong hint cannot override the key\u2019s own account', /if \(accounts\.length === 1\)/.test(binding));
check('the hint only disambiguates a key controlling several accounts', /if \(hint && accounts\.includes\(hint\)\)/.test(binding));
check('a key controlling no account REFUSES to broadcast', /no_account_for_key/.test(binding));
check('an ambiguous key REFUSES rather than guessing', /'ambiguous'/.test(binding));
check('a failed lookup is surfaced, not swallowed', /'lookup_failed'/.test(binding));
check('successful bindings are memoized per key', /cache\.set\(pub, /.test(binding));
// A transient indexer blip must not poison the whole session: nothing is cached
// on any error path. Checked by slicing the catch block, not by a loose regex.
const catchBlock = binding.slice(binding.indexOf('} catch (e) {'), binding.indexOf('if (accounts.length === 0)'));
check('FAILED lookups are NOT cached (no poisoned session)', catchBlock.length > 0 && !catchBlock.includes('cache.set'));
check('the refusal paths do not cache either', !/throw new AccountBindingError[\s\S]{0,120}cache\.set/.test(binding));

// cp445 (round 2) — the deeper fix. The account name is no longer origin-wide at
// all: it is stored under a key derived from the session's posting pubkey, so two
// tabs holding two accounts cannot collide even before any network lookup runs.
check('the stored account name is scoped to the session\u2019s posting key', /function scopedAccountKey\(sessionKeyId: string\): string \{/.test(profile));
check('…and the legacy origin-wide value is migrated, not trusted', /window\.localStorage\.setItem\(scopedAccountKey\(pub\), legacy\)/.test(profile));
check('the cross-tab storage listener will not rewrite a tab that holds keys', /if \(currentSessionKeyId\(\) !== null\) return;/.test(profile));
check('getUserBlurtAccount prefers the in-memory, session-bound value', /const inMemory = get\(blurtAccountName\);/.test(profile));
check('profile.ts does NOT import the identity store (cycle: identity imports profile)', !/from '\$stores\/identity'/.test(profile));

// The identity store drives the binding on EVERY transition, so no `internal.set`
// call site can forget to do it.
const idStore = strip(read('src', 'lib', 'stores', 'identity.ts'));
check('every unlock/lock rebinds account storage to the session\u2019s key', /internal\.subscribe\(\(state\) => \{[\s\S]{0,240}bindSessionPostingKey/.test(idStore));
// The identity store is on the every-page baseline: it must NOT reach for the
// BLT formatter, which drags bip39 + secp256k1 into first paint (cp271).
check('…without importing $crypto/keygen into the baseline', !/from '\$crypto\/keygen'/.test(idStore));
check('…using the public key itself as the session key id', /function sessionKeyId\(publicKey: Uint8Array\): string/.test(idStore));

// Last line of defence: never let a mismatched key reach the chain.
check('a posting-auth op pre-flights the account\u2019s on-chain authority', /await assertKeyControlsAccount\(live, signingAccount\);/.test(sign));
check('…and that check refuses with `key_not_in_authority`', /'key_not_in_authority'/.test(binding));
check('the refusal names the account, so the user learns which tab they are in', /is not a posting key of @\$\{account\}/.test(binding));

// The user must never read a chain dump for a two-tab mistake.
const settings = strip(read('src', 'routes', '[lang]', 'settings', '+page.svelte'));
check('settings maps AccountBindingError to human copy BEFORE ChainRejectedError', settings.indexOf('err instanceof AccountBindingError') < settings.indexOf('err instanceof ChainRejectedError'));
check('…with a "wrong account" message', /broadcast_err\.wrong_account/.test(settings));

// ── the alias trap that broke wallet-op-builders-smoke ──────────────
// In `tsconfig.smoke.json`, `$blurt/*` resolves to apps/indexer/src/blurt/* —
// but in web's Vite config it means apps/web/src/lib/blurt/*. A VALUE import
// through it compiles, type-checks, and then dies under tsx with
// ERR_MODULE_NOT_FOUND. (Type-only imports are erased, so they're harmless.)
//
// 18 pre-existing web .ts files already import this way and survive only
// because no smoke happens to import them at runtime. That collision is filed
// in REVISIT-LIST; this check pins the two files the battery DOES pull in.
const noAliasImport = (src: string): boolean =>
	!/^\s*import\s+(?!type\b)[^;]*from '\$blurt\//m.test(src);
check('sign.ts imports accountBinding relatively, not through $blurt', noAliasImport(read('src', 'lib', 'blurt', 'sign.ts')));
check('accountBinding.ts likewise', noAliasImport(binding));

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} account-binding scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} account-binding checks FAILED`);
	process.exit(1);
}
