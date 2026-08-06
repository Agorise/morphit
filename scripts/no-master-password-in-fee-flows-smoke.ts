#!/usr/bin/env tsx
/**
 * scripts/no-master-password-in-fee-flows-smoke.ts
 *
 * v1.8.15 (cp555) — SECURITY guard: Morphit never asks for, accepts, or even
 * mentions a master password.
 *
 * THE POLICY (Ken, stated three times). A "master password" is the pre-fork
 * Blurt account secret from which EVERY role's key is derived — owner included.
 * Typing it into a web form hands over the key that can steal the whole account.
 * Morphit's own "Morphit password" (which unlocks the LOCAL keystore) is a
 * completely different, safe thing. Security is priority #2, behind privacy #1,
 * and this line is absolute: the active-key unlock flow accepts an Active-key
 * WIF and nothing else; a non-WIF string is refused outright, never tried as an
 * account-wide secret.
 *
 * THE BUG THIS ALSO LOCKS THE FIX FOR. A posting-only user could not pay the
 * first-contact fee: StrangerFeeModal only offered the Morphit-password path,
 * which for a posting-only session has no active-key envelope and dead-ended at
 * "Payment could not be broadcast." The fix renders the SAME UnlockActiveKeyModal
 * the "Pay now" flow uses, so the user pastes their Active key (WIF) — plus their
 * Morphit password if they keep it — in one modal, and we sign with the ephemeral
 * scalar then wipe it.
 *
 * WHAT THIS SMOKE ASSERTS (structural — fails at lint time if any of it regresses):
 *   1. the masterPassword.ts crypto module is GONE.
 *   2. the money gate (activeKeyUnlock.ts) carries no master-password machinery:
 *      classifySecret is WIF-only ('wif'|'not_wif'|'empty'), UnlockResult.source
 *      is 'wif' only, and a non-WIF secret is refused as invalid_wif.
 *   3. the three fee flows (StrangerFeeModal, PayBlurtModal, post form) import
 *      nothing master-password and reference no master-password symbol.
 *   4. StrangerFeeModal wires UnlockActiveKeyModal + the ephemeral-scalar path,
 *      so a posting-only user can actually pay.
 *   5. NOWHERE in apps/web/src (code, comment-stripped) does the token
 *      masterPassword / master_password survive.
 *   6. NO locale advertises a "master password" (the term is scrubbed from all
 *      user-facing copy); the reassurance key was renamed to no_account_wide_password.
 *
 * COMMENTS ARE STRIPPED BEFORE GREPPING CODE. This guard's evidence is the code,
 * and a guard about a term necessarily names that term in its own prose; a raw
 * grep would trip on this very file and on explanatory comments. The blunt
 * stripper can only REMOVE evidence, so its failure mode is a false ALARM
 * (noisy, fixed), never a false pass. Locale JSON has no comments and is grepped
 * raw.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Canonical locale list — never hardcode the set (locale-source-of-truth-smoke
// enforces this). locales.ts is a pure-data module (no imports), safe in Node.
import { SUPPORTED_LOCALES } from '../apps/web/src/lib/i18n/locales';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** Blunt comment strip (block + line, with a `:` guard so `https://` survives). */
const stripComments = (src: string): string =>
	src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const readStripped = (rel: string): string => stripComments(readFileSync(resolve(REPO, rel), 'utf8'));

interface Scenario {
	name: string;
	ok: boolean;
	detail?: string;
}
const results: Scenario[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok, detail });
};

console.log('\n── no-master-password / posting-only-fee security smoke ───\n');

// ── 1. the module is gone ──────────────────────────────
const MASTER_MODULE = 'apps/web/src/lib/crypto/masterPassword.ts';
check(
	'masterPassword.ts crypto module is deleted',
	!existsSync(resolve(REPO, MASTER_MODULE)),
	`${MASTER_MODULE} still exists — the master-password derivation machinery must not be in the tree`
);

// ── 2. the money gate is WIF-only ──────────────────────
const GATE = 'apps/web/src/lib/crypto/activeKeyUnlock.ts';
const gate = readStripped(GATE);
check('activeKeyUnlock has no masterPassword symbol', !/masterPassword/i.test(gate), GATE);
check(
	'activeKeyUnlock classifySecret is WIF-only (wif|not_wif|empty)',
	/classifySecret\s*\([^)]*\)\s*:\s*'wif'\s*\|\s*'not_wif'\s*\|\s*'empty'/.test(gate),
	`${GATE} — classifySecret must not return 'master_password'`
);
check(
	'activeKeyUnlock UnlockResult.source is only "wif"',
	/source:\s*'wif'\s*}/.test(gate) && !/source:\s*'wif'\s*\|\s*'master_password'/.test(gate),
	GATE
);
{
	// The resolver must refuse a non-WIF outright as invalid_wif (never derive
	// keys from a passphrase). Scope to the resolveActiveKey body.
	const fnMatch = gate.match(/export\s+async\s+function\s+resolveActiveKey[\s\S]*?\n}/);
	const fnBody = fnMatch ? fnMatch[0] : '';
	check(
		'resolveActiveKey refuses a non-WIF secret as invalid_wif',
		/kind\s*===\s*'not_wif'[\s\S]*?reason:\s*'invalid_wif'/.test(fnBody),
		`${GATE} — a non-WIF secret must map to invalid_wif, not be tried as an account-wide secret`
	);
	check(
		'resolveActiveKey body has no master-password derivation',
		!/masterPassword/i.test(fnBody),
		GATE
	);
}

// ── 3. fee flows reference nothing master-password ─────
const FEE_FLOWS = [
	'apps/web/src/lib/components/StrangerFeeModal.svelte',
	'apps/web/src/lib/components/PayBlurtModal.svelte',
	'apps/web/src/routes/[lang]/post/+page.svelte'
];
for (const rel of FEE_FLOWS) {
	const src = readStripped(rel);
	check(`${rel.split('/').pop()} references no masterPassword symbol`, !/masterPassword/i.test(src), rel);
}

// ── 4. StrangerFeeModal wires the posting-only path ────
const SFM = 'apps/web/src/lib/components/StrangerFeeModal.svelte';
const sfm = readStripped(SFM);
check(
	'StrangerFeeModal imports UnlockActiveKeyModal',
	/import\s+UnlockActiveKeyModal\s+from/.test(sfm),
	SFM
);
check(
	'StrangerFeeModal renders <UnlockActiveKeyModal> for the no-active-key case',
	/<UnlockActiveKeyModal\b/.test(sfm) && /\{:else\}[\s\S]*<UnlockActiveKeyModal\b/.test(sfm),
	SFM
);
check(
	'StrangerFeeModal has the ephemeral-scalar signer (payWithEphemeralActiveKey)',
	/function\s+payWithEphemeralActiveKey\s*\(/.test(sfm),
	SFM
);
check(
	'StrangerFeeModal wipes the ephemeral scalar (sodium.memzero)',
	/sodium\.memzero\s*\(/.test(sfm),
	SFM
);
check(
	'StrangerFeeModal gates on hasActiveKey (activePublicKey)',
	/hasActiveKey\s*=\s*\$derived\([\s\S]*activePublicKey/.test(sfm),
	SFM
);

// ── 4b. active-key UX PARITY across EVERY spend flow ───
// Ken (t.txt #3): wherever an active key is needed, the spot must offer the
// SAME unlock UX the "Pay now" flow uses — Active-key WIF + optional Morphit
// password, one-time-use OR keep-encrypted — never a bare password field that
// dead-ends a posting-only session. This locks that invariant across all of
// them, so a NEW active-key flow can't ship with only the password path again.
const ACTIVE_KEY_FLOWS: Array<{ rel: string; ephemeral: RegExp }> = [
	{ rel: 'apps/web/src/lib/components/PayBlurtModal.svelte', ephemeral: /payWithEphemeralActiveKey/ },
	{ rel: 'apps/web/src/lib/components/StrangerFeeModal.svelte', ephemeral: /payWithEphemeralActiveKey/ },
	{ rel: 'apps/web/src/lib/components/SendBlurtModal.svelte', ephemeral: /(payWithEphemeralActiveKey|EphemeralActiveKey)/ },
	{ rel: 'apps/web/src/lib/components/PowerModal.svelte', ephemeral: /powerWithEphemeralActiveKey/ },
	{ rel: 'apps/web/src/lib/components/FeatureBidForm.svelte', ephemeral: /bidWithEphemeralActiveKey/ }
];
for (const { rel, ephemeral } of ACTIVE_KEY_FLOWS) {
	const src = readStripped(rel);
	const short = rel.split('/').pop();
	check(
		`${short} renders <UnlockActiveKeyModal> for posting-only`,
		/<UnlockActiveKeyModal\b/.test(src),
		`${rel} — an active-key flow must offer the in-place unlock, not a password-only dead end`
	);
	check(
		`${short} gates the unlock on hasActiveKey (activePublicKey)`,
		/hasActiveKey\s*=\s*\$derived\([\s\S]*activePublicKey/.test(src),
		rel
	);
	check(
		`${short} signs posting-only with an ephemeral scalar and wipes it`,
		ephemeral.test(src) && /sodium\.memzero\s*\(/.test(src),
		`${rel} — the pasted Active key must be used once then memzero'd, never persisted here`
	);
}
// The /post listing-fee step renders it via an overlay (showUnlockForFee).
{
	const post = readStripped('apps/web/src/routes/[lang]/post/+page.svelte');
	check(
		'post form step 4 renders <UnlockActiveKeyModal> for the listing fee',
		/<UnlockActiveKeyModal\b/.test(post) && /showUnlockForFee/.test(post),
		'apps/web/src/routes/[lang]/post/+page.svelte — posting-only listing-fee payment must offer the unlock modal'
	);
}

// ── 5. the token is gone everywhere in web src (stripped) ─
const WEB_SRC = resolve(REPO, 'apps/web/src');
const offenders: string[] = [];
const walk = (dir: string): void => {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry.startsWith('.')) continue;
			walk(full);
			continue;
		}
		const ext = extname(entry);
		if (ext !== '.ts' && ext !== '.svelte') continue;
		if (/masterPassword|master_password/i.test(stripComments(readFileSync(full, 'utf8')))) {
			offenders.push(full.slice(REPO.length + 1));
		}
	}
};
walk(WEB_SRC);
check(
	'no masterPassword / master_password token anywhere in apps/web/src (code)',
	offenders.length === 0,
	offenders.length ? `offending files: ${offenders.join(', ')}` : undefined
);

// ── 6. locales carry no "master password" term ─────────
const LOCALES = resolve(REPO, 'apps/web/src/lib/i18n/locales');
const LANGS = SUPPORTED_LOCALES.map((l) => l.code);
// Translated forms of "master password" that must NOT appear in copy. (Chinese
// 主密钥/主密鑰 = master KEY appears legitimately in Monero subaddress copy, so we
// target the PASSWORD forms only: 主密码 / 主密碼.)
const TERMS = [
	/master ?password/i,
	/master-?passwort/i,
	/contraseña maestra/i,
	/mot de passe ma[iî]tre/i,
	/主密码/,
	/主密碼/,
	/мастер-пароль/i,
	/hasło główne/i,
	/رمز اصلی/
];
const localeOffenders: string[] = [];
let renamedKeyPresent = true;
for (const lang of LANGS) {
	const p = join(LOCALES, `${lang}.json`);
	const raw = readFileSync(p, 'utf8');
	if (TERMS.some((re) => re.test(raw))) localeOffenders.push(`${lang}.json`);
	const parsed = JSON.parse(raw) as { backup_keys_panel?: Record<string, unknown> };
	const panel = parsed.backup_keys_panel ?? {};
	if (!('no_account_wide_password' in panel) || 'no_master_password' in panel) renamedKeyPresent = false;
}
check(
	'no locale advertises a "master password" term',
	localeOffenders.length === 0,
	localeOffenders.length ? `offending locales: ${localeOffenders.join(', ')}` : undefined
);
check(
	'backup panel reassurance key renamed to no_account_wide_password in all 10 locales',
	renamedKeyPresent,
	'some locale still has no_master_password or is missing no_account_wide_password'
);

// ── report ─────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) {
	console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
	if (!r.ok && r.detail) console.log(`      ${r.detail}`);
}
console.log('\n──────────────────────────────────────────────────────');
if (failed.length > 0) {
	console.log(`✗ ${failed.length}/${results.length} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${results.length} scenarios passed`);
