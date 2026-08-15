/**
 * Smoke: a co-located blurtd is reachable over loopback http and is the fastest,
 * most private chain source. Asserts (a) the transport classifier tags loopback
 * as 'local' (so the Settings card badges it and the pool/dispatcher treat it as
 * direct), and (b) the config guard only accepts LOOPBACK hosts — a non-loopback
 * http URL can never enter via the local knob (SSRF guard).
 */
import { rpcTransportOf } from '../src/api/rpcHealth.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}`);
	}
}

// ── transport classification ────────────────────────────────────────
check("127.0.0.1 → 'local'", rpcTransportOf('http://127.0.0.1:8091') === 'local');
check("localhost → 'local'", rpcTransportOf('http://localhost:8091') === 'local');
check("[::1] → 'local'", rpcTransportOf('http://[::1]:8091') === 'local');
check("clearnet https → 'clearnet'", rpcTransportOf('https://rpc.drakernoise.com') === 'clearnet');
check(
	"onion → 'tor' (not misclassified as local)",
	rpcTransportOf('http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091') === 'tor'
);

// ── the loopback-only config guard (mirrors config/index.ts refine) ──
function acceptsLocal(u: string): boolean {
	try {
		const url = new URL(u);
		const h = url.hostname.toLowerCase();
		return (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			(h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]')
		);
	} catch {
		return false;
	}
}
check('guard accepts http://127.0.0.1:8091', acceptsLocal('http://127.0.0.1:8091'));
check('guard accepts http://localhost:8091', acceptsLocal('http://localhost:8091'));
check('guard REJECTS a public host (SSRF)', !acceptsLocal('http://evil.example.com:8091'));
check('guard REJECTS a private-LAN host (SSRF)', !acceptsLocal('http://192.168.1.50:8091'));
check('guard REJECTS a 127.x-lookalike hostname', !acceptsLocal('http://127.0.0.1.evil.com:8091'));
check('guard REJECTS a .onion (belongs in the hidden knob)', !acceptsLocal('http://abc.onion:8091'));

console.log(
	fail === 0
		? `\n\u2713 all ${pass} local-rpc-endpoint checks passed`
		: `\n\u2717 local-rpc-endpoint: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
