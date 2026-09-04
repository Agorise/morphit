#!/usr/bin/env tsx
/**
 * hidden-only-fail-closed-smoke.ts (v1.15.x stage 1)
 *
 * Pins the deanonymisation-critical routing:
 *   - isClearnetOrigin: only PUBLIC clearnet is "clearnet"; .onion/.i2p/.loki,
 *     localhost/loopback, and RFC1918/ULA/link-local are NOT.
 *   - the dispatcher in 'refuse' (hidden-only) mode FAIL-CLOSES a public clearnet
 *     origin (errors the handler, never hands it to the direct agent) while still
 *     routing .onion→tor, .b32.i2p→i2p, and allowing local/.loki.
 *   - 'allow' mode is byte-for-byte the old behaviour (clearnet → direct).
 */
import {
	isClearnetOrigin,
	hiddenRouteOf,
	HiddenServiceRoutingDispatcher
} from '../src/indexer/hiddenServiceDispatcher.ts';

let pass = 0;
const fails: string[] = [];
const ok = (m: string, cond: boolean): void => {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${m}`);
	} else {
		fails.push(m);
		console.log(`  \u2717 ${m}`);
	}
};

const ONION = 'http://axj4qkjwk3bwh2lrn4bud5rrgsyrvuamd6jxdlmks6flsrju7q5rb5yd.onion:8091';
const I2P = 'http://7tea4n3co3q2ozke2ovgqn7j5zirkauxipfttudbhthkat6fzlcq.b32.i2p:8091';

// ── isClearnetOrigin ──
ok('public https host is clearnet', isClearnetOrigin('https://api.blurt.blog') === true);
ok('public host with port is clearnet', isClearnetOrigin('https://frankfurter.dev:443') === true);
ok('.onion is NOT clearnet', isClearnetOrigin(ONION) === false);
ok('.i2p is NOT clearnet', isClearnetOrigin(I2P) === false);
ok('.loki is NOT clearnet (lokinet tun)', isClearnetOrigin('http://morphit.loki') === false);
ok('localhost is NOT clearnet', isClearnetOrigin('http://localhost:8081') === false);
ok('127.0.0.1 is NOT clearnet', isClearnetOrigin('http://127.0.0.1:5001') === false);
ok('172.18.x (docker) is NOT clearnet', isClearnetOrigin('http://172.18.0.1:8081') === false);
ok('10.x is NOT clearnet', isClearnetOrigin('http://10.0.0.5') === false);
ok('192.168.x is NOT clearnet', isClearnetOrigin('http://192.168.1.10') === false);
ok('169.254.x link-local is NOT clearnet', isClearnetOrigin('http://169.254.1.1') === false);
ok('IPv6 ULA [fd..] is NOT clearnet', isClearnetOrigin('http://[fd00::1]:80') === false);
ok('a public IP is clearnet', isClearnetOrigin('http://8.8.8.8') === true);

// ── dispatcher fail-closed behaviour ──
type Sub = { dispatch: (o: unknown, h: unknown) => boolean; name: string; hits: number };
function makeSub(name: string): Sub {
	const s: Sub = { name, hits: 0, dispatch: () => true };
	s.dispatch = (): boolean => {
		s.hits++;
		return true;
	};
	return s;
}
function run(policy: 'allow' | 'refuse', origin: string) {
	const direct = makeSub('direct');
	const tor = makeSub('tor');
	const i2p = makeSub('i2p');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const disp = new HiddenServiceRoutingDispatcher({ direct, tor, i2p } as any, policy);
	let onErr: Error | null = null;
	const handler = {
		onConnect: (): void => {},
		onError: (e: Error): void => {
			onErr = e;
		},
		onHeaders: (): boolean => true,
		onData: (): boolean => true,
		onComplete: (): void => {}
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	disp.dispatch({ origin } as any, handler as any);
	return { direct, tor, i2p, onErr };
}

// refuse (hidden-only): public clearnet fail-closed, nothing dispatched.
{
	const r = run('refuse', 'https://api.blurt.blog/price_info');
	ok('refuse: public clearnet is errored (fail-closed)', r.onErr !== null);
	ok('refuse: public clearnet is NEVER handed to the direct agent', r.direct.hits === 0);
}
// refuse: .onion still routes to tor; .i2p to i2p.
{
	const r = run('refuse', ONION);
	ok('refuse: .onion still routes to Tor', r.tor.hits === 1 && r.onErr === null);
	const r2 = run('refuse', I2P);
	ok('refuse: .b32.i2p still routes to i2p', r2.i2p.hits === 1 && r2.onErr === null);
}
// refuse: local/loopback still allowed (direct), not refused.
{
	const r = run('refuse', 'http://127.0.0.1:5001/api');
	ok('refuse: loopback still reaches the direct agent (local IPFS/DB unaffected)', r.direct.hits === 1 && r.onErr === null);
}
// allow (classic): clearnet → direct, unchanged.
{
	const r = run('allow', 'https://api.blurt.blog/price_info');
	ok('allow: clearnet goes to the direct agent (unchanged)', r.direct.hits === 1 && r.onErr === null);
}

// sanity: routing decision unchanged for hidden nets
ok('hiddenRouteOf(.onion) === tor', hiddenRouteOf(ONION) === 'tor');
ok('hiddenRouteOf(.i2p) === i2p', hiddenRouteOf(I2P) === 'i2p');
ok('hiddenRouteOf(clearnet) === direct', hiddenRouteOf('https://api.blurt.blog') === 'direct');

console.log('');
if (fails.length > 0) {
	console.log(`\u2717 ${fails.length} of ${pass + fails.length} hidden-only-fail-closed checks FAILED`);
	for (const f of fails) console.log(`    - ${f}`);
	process.exit(1);
}
console.log(`\u2713 all ${pass} hidden-only-fail-closed scenarios passed`);
