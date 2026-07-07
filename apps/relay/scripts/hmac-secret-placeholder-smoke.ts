/**
 * hmac-secret-placeholder smoke — cp252.
 *
 * Regression guard for a real security finding: `MORPHIT_RELAY_INVITE_HMAC_SECRET`
 * and `MORPHIT_RELAY_ALTCHA_HMAC_SECRET` were declared as a bare
 * `z.string().optional()` with NO placeholder/length refinement, even though
 * `ops/env/relay.env.example` shipped them UNCOMMENTED as `__SET_BEFORE_DEPLOY__`
 * and its comment promised "The relay refuses to boot when either is empty or a
 * known placeholder." It didn't. A manual-install operator who copied the example
 * and deployed without editing would run the invite-token + Altcha signers with a
 * PUBLICLY-KNOWN HMAC secret (forgeable invite tokens / Altcha-bypass) — strictly
 * worse than leaving the var unset, which yields a secure random per-boot secret
 * (see policy/inviteToken.ts + policy/altcha.ts; main.ts passes `null` ⇒ the
 * policy generates `randomBytes(32)`).
 *
 * Fix (cp252): `hmacSecretSchema` — still `.optional()` (unset ⇒ secure ephemeral
 * default, the intended design), but if a value IS set it must NOT be a known
 * placeholder sentinel and must be ≥16 chars. The relay.env.example lines are now
 * commented out (un-edited copy ⇒ secure default) with an accurate comment.
 *
 * This smoke asserts the schema's accept/reject behavior so a future refactor
 * can't silently revert to the bare `.optional()`.
 */

import { hmacSecretSchema } from '../src/config/index.ts';

interface Result {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

const results: Result[] = [];
function expectAccept(name: string, value: string | undefined): void {
	const ok = hmacSecretSchema.safeParse(value).success === true;
	results.push({ name, ok, detail: ok ? undefined : `expected ACCEPT, got reject for ${JSON.stringify(value)}` });
}
function expectReject(name: string, value: string | undefined): void {
	const ok = hmacSecretSchema.safeParse(value).success === false;
	results.push({ name, ok, detail: ok ? undefined : `expected REJECT, got accept for ${JSON.stringify(value)}` });
}

console.log('\n── hmac-secret-placeholder smoke (cp252) ──────────────\n');

// Unset ⇒ accepted (the secure ephemeral default).
expectAccept('undefined (unset) is accepted — secure random per-boot default', undefined);

// Known placeholder sentinels ⇒ rejected.
expectReject('rejects __SET_BEFORE_DEPLOY__ (the example placeholder)', '__SET_BEFORE_DEPLOY__');
expectReject('rejects CHANGE_ME_BEFORE_PRODUCTION', 'CHANGE_ME_BEFORE_PRODUCTION');
expectReject('rejects CHANGE_ME', 'CHANGE_ME');
expectReject('rejects CHANGEME', 'CHANGEME');
expectReject("rejects 'password'", 'password');
expectReject("rejects 'postgres'", 'postgres');

// Too-short values ⇒ rejected (need ≥16 chars).
expectReject('rejects empty string', '');
expectReject('rejects a 15-char value (below the 16 floor)', 'a'.repeat(15));

// Boundary + real secrets ⇒ accepted.
expectAccept('accepts a 16-char value (the floor)', 'a'.repeat(16));
expectAccept('accepts a 32-char random-looking secret', 'Zk9xQ2vRt7mLpW3nB8sY1aH6cD4fG0eJ');
expectAccept('accepts a realistic `openssl rand -base64 32` output', 'h8Hc1mWqf3oP9zR2tA6yB0sN4uK7dL5xE1gJ3vC9wM');

// ─── Report ───────────────────────────────────────────────
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${results.length} hmac-secret-placeholder scenarios pass`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} hmac-secret-placeholder failures`);
	process.exit(1);
}
