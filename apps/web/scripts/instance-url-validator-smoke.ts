/**
 * instance-url-validator-smoke — pins validateInstanceUrl (the /compare page's
 * gate on which remote instances we'll fetch an orderbook from).
 *
 * v1.16.9 — the validator now accepts http AND https so zero-clearnet instances
 * (.onion/.i2p over http) can be compared, and a bare hidden-network host
 * defaults to http:// (clearnet defaults to https://). Non-web schemes and
 * userinfo are still rejected.
 */
import { validateInstanceUrl } from '../src/lib/utils/instanceUrl.ts';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		pass++;
	} else {
		fail++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

function expectOk(name: string, raw: string, origin: string): void {
	const r = validateInstanceUrl(raw);
	ok(name, r.ok && r.origin === origin, r.ok ? `got origin ${r.origin}` : `rejected: ${r.reason}`);
}
function expectReason(name: string, raw: string, reason: string): void {
	const r = validateInstanceUrl(raw);
	ok(name, !r.ok && r.reason === reason, r.ok ? `unexpectedly ok (${r.origin})` : `got ${r.reason}`);
}

// clearnet
expectOk('https:// clearnet kept', 'https://morphit.io', 'https://morphit.io');
expectOk('bare clearnet host defaults to https', 'morphit.io', 'https://morphit.io');
expectOk('http:// clearnet now accepted (http or https)', 'http://morphit.io', 'http://morphit.io');
expectOk('clearnet host with path → origin only', 'https://morphit.io/en/orderbook', 'https://morphit.io');

// zero-clearnet (the whole point of this change)
const ONION = 'ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion';
expectOk('bare .onion defaults to http', ONION, `http://${ONION}`);
expectOk('http:// .onion accepted', `http://${ONION}`, `http://${ONION}`);
expectOk('https:// .onion accepted too', `https://${ONION}`, `https://${ONION}`);
expectOk('bare .onion with trailing slash', `${ONION}/`, `http://${ONION}`);
expectOk('bare .i2p b32 defaults to http', 'abcd1234.b32.i2p', 'http://abcd1234.b32.i2p');
expectOk('bare .i2p defaults to http', 'example.i2p', 'http://example.i2p');
expectOk('bare .loki defaults to http', 'example.loki', 'http://example.loki');

// rejections still hold
expectReason('empty is empty', '', 'empty');
expectReason('ftp scheme rejected', 'ftp://morphit.io', 'invalid_scheme');
expectReason('javascript scheme rejected', 'javascript:alert(1)', 'invalid_scheme');
expectReason('data scheme rejected', 'data:text/html,x', 'invalid_scheme');
expectReason('userinfo rejected', 'https://user:pass@morphit.io', 'has_userinfo');
expectReason('too long rejected', 'https://' + 'a'.repeat(300) + '.io', 'too_long');

if (fail === 0) {
	console.log(`✓ all ${pass} instance-url-validator scenarios passed`);
} else {
	console.error(`✗ ${fail} of ${pass + fail} instance-url-validator scenarios FAILED`);
	process.exit(1);
}
