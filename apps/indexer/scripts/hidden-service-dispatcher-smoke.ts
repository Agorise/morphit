/**
 * Security smoke for the hidden-service routing dispatcher.
 *
 * The whole safety case rests on two properties, both asserted here without a
 * network:
 *   1. The routing DECISION (`hiddenRouteOf`) sends ONLY .onion→tor and
 *      .i2p→i2p; everything else (clearnet, .loki, junk) → direct.
 *   2. The DELEGATION never proxies clearnet: a clearnet origin always goes to
 *      the direct sub-dispatcher, and a hidden origin with no proxy configured
 *      falls back to direct (fail-safe, doesn't crash).
 */
import {
	hiddenRouteOf,
	HiddenServiceRoutingDispatcher
} from '../src/indexer/hiddenServiceDispatcher.ts';
import type { Dispatcher } from 'undici';

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

const ONION = 'f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad'; // 56-char v3
const B32 = 'zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa';

// ── 1. hiddenRouteOf — the routing decision ─────────────────────────
check('onion v3 → tor', hiddenRouteOf(`http://${ONION}.onion:8091`) === 'tor');
check('onion v3 (no port) → tor', hiddenRouteOf(`http://${ONION}.onion`) === 'tor');
check('b32.i2p → i2p', hiddenRouteOf(`http://${B32}.b32.i2p:8091`) === 'i2p');
check('named .i2p → i2p', hiddenRouteOf('http://something.i2p') === 'i2p');
check('clearnet https → direct', hiddenRouteOf('https://rpc.drakernoise.com') === 'direct');
check('clearnet http → direct', hiddenRouteOf('http://example.com') === 'direct');
check('.loki → direct (lokinet tun, not proxied)', hiddenRouteOf('http://foo.loki') === 'direct');
check('garbage → direct', hiddenRouteOf('not a url') === 'direct');
// A too-short "onion" (not 56 chars) must NOT be treated as tor — it's not a
// valid v3 address, so it falls through to direct where it fails DNS. Guards
// against a spoofed short .onion sneaking onto the Tor path.
check('short fake .onion → direct (not tor)', hiddenRouteOf('http://abc.onion') === 'direct');

// ── 2. delegation: each origin lands on exactly the right sub-dispatcher ──
function spy(tag: string, sink: string[]): Dispatcher {
	return {
		dispatch(opts: { origin?: string | URL }): boolean {
			const o = opts.origin;
			sink.push(`${tag}:${typeof o === 'string' ? o : (o?.href ?? '')}`);
			return true;
		},
		close: async () => {},
		destroy: async () => {}
	} as unknown as Dispatcher;
}

const noopHandler = {} as unknown as Dispatcher.DispatchHandler;

{
	const hits: string[] = [];
	const router = new HiddenServiceRoutingDispatcher({
		direct: spy('direct', hits),
		tor: spy('tor', hits),
		i2p: spy('i2p', hits)
	});
	router.dispatch({ origin: 'https://rpc.drakernoise.com', path: '/', method: 'POST' }, noopHandler);
	router.dispatch({ origin: `http://${ONION}.onion:8091`, path: '/', method: 'POST' }, noopHandler);
	router.dispatch({ origin: `http://${B32}.b32.i2p:8091`, path: '/', method: 'POST' }, noopHandler);
	check('clearnet → direct (never proxied)', hits[0].startsWith('direct:https://rpc.drakernoise.com'));
	check('onion → tor sub-dispatcher', hits[1].startsWith('tor:'));
	check('b32.i2p → i2p sub-dispatcher', hits[2].startsWith('i2p:'));
	check('exactly one delegation per dispatch', hits.length === 3);
	void router.closeAll();
}

{
	// Proxies NOT configured → hidden falls back to direct (fail-safe, no crash).
	const hits: string[] = [];
	const router = new HiddenServiceRoutingDispatcher({ direct: spy('direct', hits) });
	router.dispatch({ origin: `http://${ONION}.onion:8091`, path: '/', method: 'POST' }, noopHandler);
	router.dispatch({ origin: `http://${B32}.b32.i2p:8091`, path: '/', method: 'POST' }, noopHandler);
	check('no-proxy: hidden origins fall back to direct (fail-safe)', hits.length === 2 && hits.every((h) => h.startsWith('direct:')));
	void router.closeAll();
}

console.log(
	fail === 0
		? `\n\u2713 all ${pass} hidden-service-dispatcher checks passed`
		: `\n\u2717 hidden-service-dispatcher: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
