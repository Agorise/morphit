/**
 * Onion-location helper — pure-function smoke.
 *
 * Verifies the helper that produces the `onion-location` meta
 * tag value: emit when configured AND not already on .onion;
 * suppress otherwise.  Defensive against operator misconfig
 * (non-.onion address, scheme prefix, trailing slash, empty).
 */

import { computeOnionLocation } from '../../web/src/lib/seo/onionLocation';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── onion-location helper ─────────────────────────────────\n');

scenario('no tor address → null', () => {
	const r = computeOnionLocation({
		torAddress: null,
		currentHostname: 'morphit.io',
		currentPathname: '/'
	});
	if (r !== null) throw new Error(`got ${r}`);
});

scenario('undefined tor → null', () => {
	const r = computeOnionLocation({
		torAddress: undefined,
		currentHostname: 'morphit.io',
		currentPathname: '/'
	});
	if (r !== null) throw new Error(`got ${r}`);
});

scenario('empty tor → null', () => {
	const r = computeOnionLocation({
		torAddress: '',
		currentHostname: 'morphit.io',
		currentPathname: '/'
	});
	if (r !== null) throw new Error(`got ${r}`);
});

scenario('plain onion address → http://addr/path', () => {
	const r = computeOnionLocation({
		torAddress: 'morphitabc123.onion',
		currentHostname: 'morphit.io',
		currentPathname: '/'
	});
	if (r !== 'http://morphitabc123.onion/') throw new Error(`got ${r}`);
});

scenario('strips http:// scheme prefix', () => {
	const r = computeOnionLocation({
		torAddress: 'http://morphitabc123.onion',
		currentHostname: 'morphit.io',
		currentPathname: '/orderbook'
	});
	if (r !== 'http://morphitabc123.onion/orderbook') throw new Error(`got ${r}`);
});

scenario('strips https:// scheme prefix', () => {
	const r = computeOnionLocation({
		torAddress: 'https://morphitabc123.onion/',
		currentHostname: 'morphit.io',
		currentPathname: '/'
	});
	if (r !== 'http://morphitabc123.onion/') throw new Error(`got ${r}`);
});

scenario('preserves search + hash', () => {
	const r = computeOnionLocation({
		torAddress: 'morphitabc123.onion',
		currentHostname: 'morphit.io',
		currentPathname: '/orderbook',
		currentSearch: '?asset=BTC',
		currentHash: '#filter'
	});
	if (r !== 'http://morphitabc123.onion/orderbook?asset=BTC#filter') {
		throw new Error(`got ${r}`);
	}
});

scenario('current host already .onion → null (no self-redirect)', () => {
	const r = computeOnionLocation({
		torAddress: 'morphitabc123.onion',
		currentHostname: 'morphitabc123.onion',
		currentPathname: '/'
	});
	if (r !== null) throw new Error(`got ${r}`);
});

scenario('subdomain of .onion → null', () => {
	const r = computeOnionLocation({
		torAddress: 'morphitabc123.onion',
		currentHostname: 'sub.morphitabc123.onion',
		currentPathname: '/'
	});
	if (r !== null) throw new Error(`got ${r}`);
});

scenario('non-.onion configured address → null (defensive)', () => {
	// Operator misconfigures their clearnet domain in the tor
	// field — must NOT emit, would be a Tor-Browser address-bar
	// open-redirect surface.
	const r = computeOnionLocation({
		torAddress: 'evil.com',
		currentHostname: 'morphit.io',
		currentPathname: '/'
	});
	if (r !== null) throw new Error(`got ${r}`);
});

scenario('non-.onion with scheme → null (defensive)', () => {
	const r = computeOnionLocation({
		torAddress: 'https://evil.com',
		currentHostname: 'morphit.io',
		currentPathname: '/'
	});
	if (r !== null) throw new Error(`got ${r}`);
});

scenario('empty pathname becomes root', () => {
	const r = computeOnionLocation({
		torAddress: 'morphitabc123.onion',
		currentHostname: 'morphit.io',
		currentPathname: ''
	});
	if (r !== 'http://morphitabc123.onion/') throw new Error(`got ${r}`);
});

scenario('non-string tor → null', () => {
	const r = computeOnionLocation({
		torAddress: 123 as unknown as string,
		currentHostname: 'morphit.io',
		currentPathname: '/'
	});
	if (r !== null) throw new Error(`got ${r}`);
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
