/**
 * Smoke: the release check never lets a hidden-service visitor's browser touch
 * the clear net, and the rotator's privacy-first rule keeps hidden nodes ahead
 * of clearnet ones in any pool that holds both.
 *
 * Behavioural: the app's own rotator (getRotator) is built for a `.onion` page
 * origin and the release check's own read (readSignedOp) runs on it against
 * nodes whose answers can never be verified, so it uses its whole budget (the
 * best node, then one other operator's); every node contacted must be hidden.
 * A plain-http CLEARNET origin gets the clearnet nodes (what its CSP allows —
 * rpc-pool-mixed-content-smoke). The tier rule itself is run on a rotator
 * holding both tiers whose hidden node has just failed (privacyFirst keeps it
 * first; the default rotator does not).
 */
import { EndpointRotator, getRotator, isHiddenEndpoint } from '../src/lib/net/endpoints.ts';
import { readSignedOp } from '../src/lib/net/releaseVerifyCore.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

// ── isHiddenEndpoint ────────────────────────────────────────────────
check(
	'onion is hidden',
	isHiddenEndpoint('http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv23.onion')
);
check('b32.i2p is hidden', isHiddenEndpoint('http://x'.padEnd(60, 'a') + '.b32.i2p'));
check('named .i2p is hidden', isHiddenEndpoint('http://something.i2p'));
check('clearnet https is NOT hidden', !isHiddenEndpoint('https://rpc.drakernoise.com'));
check('garbage is NOT hidden', !isHiddenEndpoint('not a url'));

// ── a simulated network: every node answers; each request is recorded ──
const contacted: string[] = [];
let down = new Set<string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	contacted.push(url);
	if (down.has(url)) throw new TypeError('NetworkError when attempting to fetch resource.');
	const { id } = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
	return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { head_block_number: 1 } }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}) as typeof fetch;

async function main(): Promise<void> {
	// ── the app's rotator on a .onion page ──
	const onionHost = 'morphitxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion';
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: {
			protocol: 'http:',
			hostname: onionHost,
			host: onionHost,
			origin: `http://${onionHost}`,
			href: `http://${onionHost}/en`
		}
	});
	const rotator = getRotator();
	const pool = rotator.getAll().map((s) => s.url);
	check(
		'the .onion pool holds hidden nodes only',
		pool.length > 0 && pool.every(isHiddenEndpoint),
		pool.join(', ')
	);
	const result = await readSignedOp(rotator, {
		signer: 'morphit',
		opId: 'morphit_release_v1',
		pinnedPubkey: 'BLT0',
		windows: [100]
	});
	check('the release read ends (nothing verifiable here)', result.ok === false);
	check(
		'getRotator() on .onion: the release read asks two nodes, both hidden',
		new Set(contacted).size === 2 && contacted.every(isHiddenEndpoint),
		contacted.join(', ')
	);

	// ── the tier rule, on a hidden node that has just failed ──
	const onion = 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv23.onion';
	const clear = 'https://rpc.beblurt.com';
	for (const privacyFirst of [true, false]) {
		const r = new EndpointRotator([clear, onion], { privacyFirst });
		down = new Set([onion]);
		// One call: whichever node is tried first, the onion records one failure.
		contacted.length = 0;
		await r.call('condenser_api.get_config').catch(() => null);
		down = new Set();
		contacted.length = 0;
		await r.call('condenser_api.get_config');
		const first = contacted[0];
		if (privacyFirst) {
			check(
				'privacyFirst: a hidden node that just failed is still tried before clearnet',
				first === onion,
				first
			);
		} else {
			check(
				'default rotator: a node that just failed goes behind a healthy one',
				first === clear,
				first
			);
		}
	}

	console.log(
		fail === 0
			? `\n✓ all ${pass} privacy-first-rpc-ordering checks passed`
			: `\n✗ privacy-first-rpc-ordering: ${pass} passed, ${fail} failed`
	);
	process.exit(fail === 0 ? 0 : 1);
}

void main();
