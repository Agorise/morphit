/**
 * relay-keystore-content-smoke.ts (cp600) — pins the one pure, security-
 * sensitive bit of the guided-install front-end: what bytes get written to the
 * relay keystore.  Encrypted mode must write the envelope JSON; plaintext must
 * write the WIF — never the wrong field, never a stray "undefined".
 */
import { relayKeystoreContent } from '../apps/ops-cli/src/init/runAnsibleInstall.ts';
import type { ActiveKeyResult } from '../apps/ops-cli/src/init/steps.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

console.log('\u2500\u2500 relay-keystore-content smoke (cp600) \u2500\u2500\u2500\u2500');

const fakeEnvelope = { v: 1, kdf: 'argon2id', salt: 'AAAA', iv: 'BBBB', ct: 'CCCC' };
const encrypted: ActiveKeyResult = {
	mode: 'encrypted',
	plaintextWif: undefined,
	envelope: fakeEnvelope as unknown as ActiveKeyResult['envelope'],
	passphraseHint: 'my hint'
};
const plaintext: ActiveKeyResult = {
	mode: 'plaintext',
	plaintextWif: '5JplaintextWifExample',
	envelope: undefined,
	passphraseHint: undefined
};

// ── encrypted mode ────────────────────────────────────────────────
const encOut = relayKeystoreContent(encrypted);
check('encrypted: writes valid JSON', (() => { try { JSON.parse(encOut); return true; } catch { return false; } })());
check('encrypted: JSON round-trips to the envelope', JSON.stringify(JSON.parse(encOut)) === JSON.stringify(fakeEnvelope));
check('encrypted: does NOT contain the string "undefined"', !encOut.includes('undefined'));
check('encrypted: does NOT leak a plaintext WIF', !encOut.includes('5J') && !encOut.includes('5K'));

// ── plaintext mode ────────────────────────────────────────────────
const plainOut = relayKeystoreContent(plaintext);
check('plaintext: writes exactly the WIF', plainOut === '5JplaintextWifExample');
check('plaintext: is NOT JSON (a bare WIF)', !plainOut.trim().startsWith('{'));

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} relay-keystore-content checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} relay-keystore-content checks failed`);
	process.exit(1);
}
