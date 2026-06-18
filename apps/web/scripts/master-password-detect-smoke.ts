#!/usr/bin/env tsx
/**
 * Smoke: `masterPasswordPubKey` must reproduce @beblurt/dblurt's
 * `PrivateKey.fromLogin(account, password, role).createPublic().toString()`
 * for every role.
 *
 * Why this matters: the import flow uses this to detect when a user pasted
 * their Blurt MASTER PASSWORD into the posting-key field (error message 6).
 * If the derivation drifts from dblurt's, detection silently breaks and the
 * user gets a generic "bad key" error instead of the precise one.
 *
 * Derivation under test: scalar = sha256(account + role + password), then
 * secp256k1 pubkey → BLT string. Must equal dblurt for all four roles.
 *
 * Tamper: change the seed concatenation order, drop a role, or alter the
 * hash → fails the dblurt-equality assertion.
 */
import { PrivateKey } from '@beblurt/dblurt';
import { masterPasswordPubKey } from '../src/lib/crypto/masterPassword.ts';

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ''): void {
	total++;
	if (ok) console.log(`  ✓ ${label}`);
	else {
		console.error(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`);
		failures++;
	}
}

console.log('master-password-detect smoke');
console.log('=============================');

const cases: Array<[string, string]> = [
	['kentest2', 'P5HwMA9Sc2tj1234ExampleMasterPasswordStringForTest'],
	['alice', 'hunter2-not-really-a-master-password'],
	['bob.witness', 'P5Jxsd9aQ' + 'z'.repeat(40)]
];
const roles = ['owner', 'active', 'posting', 'memo'] as const;

for (const [account, pw] of cases) {
	for (const role of roles) {
		const dblurtPub = PrivateKey.fromLogin(account, pw, role).createPublic().toString();
		const mine = await masterPasswordPubKey(account, role, pw);
		check(
			`${account}/${role} pubkey == dblurt`,
			mine === dblurtPub,
			`mine=${mine} dblurt=${dblurtPub}`
		);
	}
}

// Specificity: a different password for the same account/role must derive
// a DIFFERENT pubkey (so detection can't false-positive on arbitrary input).
const a = await masterPasswordPubKey('kentest2', 'posting', 'password-one');
const b = await masterPasswordPubKey('kentest2', 'posting', 'password-two');
check('different passwords → different pubkeys', !!a && !!b && a !== b);

console.log(failures === 0 ? `\n✓ all ${total} scenarios passed` : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
