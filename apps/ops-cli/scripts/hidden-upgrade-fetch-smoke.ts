#!/usr/bin/env tsx
/**
 * hidden-upgrade-fetch-smoke.ts (v1.15.x stage 3b)
 *
 * Pins the hidden-only release fetch directives:
 *   - anti-rollback: a stale/tampered tarball (wrong SHA) is rejected; a correct
 *     peer still wins.
 *   - fail-closed: no matching tarball anywhere → throws (caller stays put; never
 *     clearnet).
 *   - raced + resilient: first SHA-verified peer wins, others aborted; a slow/dead
 *     peer doesn't block a fast good one.
 *   - URL built on the peer's hidden IPNS gateway.
 */
import {
	fetchHiddenUpgrade,
	hiddenReleaseUrl,
	type HiddenUpgradeTarget,
	type HiddenUpgradeDeps
} from '../src/init/hiddenUpgradeFetch.ts';

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

const GOOD = new Uint8Array([1, 2, 3, 4]);
const STALE = new Uint8Array([9, 9, 9]);
const GOOD_SHA = 'a'.repeat(64);
const STALE_SHA = 'b'.repeat(64);
const enc = (b: Uint8Array): string => (b === GOOD ? GOOD_SHA : b === STALE ? STALE_SHA : 'c'.repeat(64));

const target: HiddenUpgradeTarget = {
	ipnsName: 'k51qzi5uqu5dhsa0lbq7release',
	expectedSha256: GOOD_SHA,
	version: 'v1.16.0',
	path: 'morphit-latest.tar.gz'
};

function deps(map: Record<string, { bytes: Uint8Array; delayMs?: number; fail?: boolean }>, extra?: Partial<HiddenUpgradeDeps>): HiddenUpgradeDeps {
	return {
		peerGateways: Object.keys(map),
		fetchTarball: (url, signal) =>
			new Promise<Uint8Array>((resolve, reject) => {
				const gw = Object.keys(map).find((g) => url.startsWith(g))!;
				const e = map[gw]!;
				const t = setTimeout(() => {
					if (e.fail) reject(new Error('peer down'));
					else resolve(e.bytes);
				}, e.delayMs ?? 1);
				signal.addEventListener('abort', () => {
					clearTimeout(t);
					reject(new Error('aborted'));
				});
			}),
		sha256: (b) => enc(b),
		raceLimit: 4,
		...extra
	};
}

async function main(): Promise<void> {
	console.log('\nhidden-upgrade-fetch smoke\n');

	// URL construction
	ok(
		'builds IPNS gateway URL on the peer hidden origin',
		hiddenReleaseUrl('http://abc.onion', target) === `http://abc.onion/ipns/${encodeURIComponent(target.ipnsName)}/morphit-latest.tar.gz`
	);

	// Happy path: one good peer.
	{
		const r = await fetchHiddenUpgrade(target, deps({ 'http://p1.onion': { bytes: GOOD } }));
		ok('single good peer → verified tarball returned', r.bytes === GOOD && r.peer === 'http://p1.onion');
	}

	// Anti-rollback: a peer serves a stale (validly-old) tarball; a good peer wins.
	{
		const r = await fetchHiddenUpgrade(
			target,
			deps({
				'http://stale.onion': { bytes: STALE, delayMs: 1 },
				'http://good.onion': { bytes: GOOD, delayMs: 5 }
			})
		);
		ok('stale tarball (wrong SHA) rejected; good peer wins', r.bytes === GOOD && r.peer === 'http://good.onion');
	}

	// All peers stale/tampered → fail-closed throw.
	{
		let threw = false;
		try {
			await fetchHiddenUpgrade(target, deps({ 'http://s1.onion': { bytes: STALE }, 'http://s2.onion': { bytes: STALE } }));
		} catch {
			threw = true;
		}
		ok('all peers stale → throws (fail-closed, no clearnet fallback)', threw);
	}

	// No peers → fail-closed throw.
	{
		let threw = false;
		try {
			await fetchHiddenUpgrade(target, deps({}));
		} catch {
			threw = true;
		}
		ok('no peer gateways → throws (fail-closed)', threw);
	}

	// Raced: a fast good peer beats a slow one; both good, first wins.
	{
		const r = await fetchHiddenUpgrade(
			target,
			deps({
				'http://fast.onion': { bytes: GOOD, delayMs: 2 },
				'http://slow.onion': { bytes: GOOD, delayMs: 500 }
			})
		);
		ok('fast good peer wins the race (slow peer aborted)', r.peer === 'http://fast.onion');
	}

	// A dead peer doesn't block a good one.
	{
		const r = await fetchHiddenUpgrade(
			target,
			deps({ 'http://dead.onion': { bytes: GOOD, fail: true }, 'http://good.onion': { bytes: GOOD, delayMs: 3 } })
		);
		ok('a dead peer is skipped; good peer still wins', r.peer === 'http://good.onion');
	}

	// Bad on-chain SHA (not 64-hex) → throw before any fetch.
	{
		let threw = false;
		try {
			await fetchHiddenUpgrade({ ...target, expectedSha256: 'not-a-hash' }, deps({ 'http://p.onion': { bytes: GOOD } }));
		} catch {
			threw = true;
		}
		ok('malformed on-chain SHA → throws before fetching', threw);
	}

	// resolvePeerGateways: chain-driven directory → hidden gateway bases.
	{
		const { resolvePeerGateways } = await import('../src/init/hiddenUpgradeFetch.ts');
		const ONION = 'axj4qkjwk3bwh2lrn4bud5rrgsyrvuamd6jxdlmks6flsrju7q5rb5yd.onion';
		const B32 = '7tea4n3co3q2ozke2ovgqn7j5zirkauxipfttudbhthkat6fzlcq.b32.i2p';
		const gws = resolvePeerGateways([{ i2p_b32: B32 }, { tor: ONION }, { tor: null, i2p_b32: null }, { i2p_b32: B32 }]);
		ok('resolves peers to hidden gateway bases, I2P-first, deduped', gws[0] === `http://${B32}` && gws.includes(`http://${ONION}`) && gws.length === 2);
		ok('peers with no hidden address are dropped', resolvePeerGateways([{ tor: 'x' }, {}]).length === 0);
	}

	// makeHiddenTarballFetcher: fail-closed on a non-hidden URL (refuse clearnet).
	{
		const { makeHiddenTarballFetcher } = await import('../src/init/hiddenUpgradeTransport.ts');
		const fetcher = makeHiddenTarballFetcher({ proxy: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '127.0.0.1:4444' } });
		let refused = false;
		try {
			await fetcher('https://git.agorise.net/release.tar.gz', new AbortController().signal);
		} catch (e) {
			refused = /refusing to fetch a non-hidden URL/.test(String(e));
		}
		ok('transport refuses a clearnet URL (fail-closed, no open-internet fetch)', refused);
	}

	console.log('');
	if (fails.length > 0) {
		console.log(`\u2717 ${fails.length} of ${pass + fails.length} hidden-upgrade-fetch checks FAILED`);
		for (const f of fails) console.log(`    - ${f}`);
		process.exit(1);
	}
	console.log(`\u2713 all ${pass} hidden-upgrade-fetch scenarios passed`);
}

void main();
