/**
 * altnet-address-format-smoke.ts (cp600) — pins looksLikeAddress, the light
 * paste-format check the wizard now runs on the OPTIONAL Lokinet/I2P/Nostr/ENS
 * addresses. A valid address of each kind must pass; a wrong-network or
 * missing-suffix paste must be rejected (so a typo can't slip into the config).
 */
import { looksLikeAddress } from '../src/init/steps.ts';

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

console.log('\u2500\u2500 altnet-address-format smoke (cp600) \u2500\u2500\u2500\u2500');

const loki = 'a'.repeat(52) + '.loki';
const i2pB32 = 'a'.repeat(52) + '.b32.i2p';
const npub = 'npub1' + 'a'.repeat(24);

// ── accept a valid address of each kind ───────────────────────────
check('loki: valid 52-char .loki accepted', looksLikeAddress('loki', loki));
check('i2p-b32: valid 52-char .b32.i2p accepted', looksLikeAddress('i2p-b32', i2pB32));
check('i2p-name: "morphit.i2p" accepted', looksLikeAddress('i2p-name', 'morphit.i2p'));
check('npub: "npub1…" accepted', looksLikeAddress('npub', npub));
check('ens: "morphit.eth" accepted', looksLikeAddress('ens', 'morphit.eth'));
check('accepts with surrounding whitespace + mixed case', looksLikeAddress('ens', '  Morphit.ETH  '));

// ── reject wrong network / missing suffix / typo ──────────────────
check('loki: rejects a .onion pasted by mistake', !looksLikeAddress('loki', 'abcd.onion'));
check('loki: rejects missing/short body', !looksLikeAddress('loki', 'short.loki') && !looksLikeAddress('loki', 'morphit'));
check('i2p-b32: rejects a .i2p name (not a b32)', !looksLikeAddress('i2p-b32', 'morphit.i2p'));
check('i2p-b32: rejects wrong length', !looksLikeAddress('i2p-b32', 'aaaa.b32.i2p'));
check('i2p-name: rejects a .b32.i2p (that is a b32, not a name)', !looksLikeAddress('i2p-name', i2pB32));
check('i2p-name: rejects a .eth', !looksLikeAddress('i2p-name', 'morphit.eth'));
check('npub: rejects an nsec (private key!) or plain text', !looksLikeAddress('npub', 'nsec1' + 'a'.repeat(24)) && !looksLikeAddress('npub', 'morphit'));
check('ens: rejects a .i2p', !looksLikeAddress('ens', 'morphit.i2p'));
check('all: reject empty', !looksLikeAddress('loki', '') && !looksLikeAddress('npub', '') && !looksLikeAddress('ens', ''));

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} altnet-address-format checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} altnet-address-format checks failed`);
	process.exit(1);
}
