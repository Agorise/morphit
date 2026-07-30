#!/usr/bin/env tsx
/**
 * composite-price-provider smoke — anchors `createCompositeProvider`.
 *
 * `apps/web/src/lib/prices/providers/composite.ts` is Phase-3
 * scaffolding: `$lib/prices/index.ts` hardcodes `fallbackProvider`
 * pending the Phase-3 decision in ADR-0004, so NO production surface
 * invokes `createCompositeProvider` yet.  The cp197 repo-wide wiring
 * audit surfaced it as the single exported source symbol with no
 * importer anywhere (runtime, test, OR smoke) — meaning its
 * chaining/cache/fallback logic could silently rot before Phase 3
 * wires it, with nothing to catch the regression.
 *
 * Its sibling `coingecko.ts` is already gate-maintained (its COIN_ID
 * map is pinned by price-provider-coverage-parity-smoke).  This smoke
 * gives composite.ts the same kind of guard: it imports the real
 * module and asserts every documented semantic, so the file is both
 * wired (into the smoke suite) and provably functional.  When Phase 3
 * lands and wires the composite into the live frontend, this guard is
 * already in place.
 *
 * Documented semantics (from composite.ts) asserted here:
 *   - provider name is 'composite'
 *   - empty upstreams → constructor throws
 *   - first upstream returning a VALID quote wins; later upstreams
 *     are not called
 *   - an invalid quote (usd ≤ 0, NaN, Infinity, or non-number) is
 *     rejected and the chain falls through to the next upstream
 *   - an upstream that throws is caught and the chain continues
 *   - all upstreams failing with no cache → propagates an error
 *   - a successful quote is cached per-symbol for cacheTtlMs, and a
 *     within-TTL re-read returns the cached quote with its ORIGINAL
 *     fetchedAt (NOT refreshed) — the "prices updated X ago" honesty
 *     contract
 *   - the cache is per-symbol (BTC cache does not serve XMR)
 *   - after TTL expiry the upstream is queried again
 *   - if all upstreams fail but a (now-stale) cache entry exists, the
 *     stale quote is served rather than throwing
 *
 * Determinism: composite.ts reads `Date.now()` directly (no injected
 * clock), so the TTL/expiry/stale paths are exercised by mocking
 * `Date.now` with a manually-advanced fake clock — no real-time
 * sleeps, so the smoke is stable under triple-pulse.
 */

import {
	createCompositeProvider,
	type CompositeProviderConfig
} from '../src/lib/prices/providers/composite.ts';
import type { PriceProvider, PriceQuote, PricedSymbol } from '../src/lib/prices/types.ts';

let passed = 0;
let failed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}
function expectEq<T>(name: string, got: T, want: T): void {
	if (got === want) pass(name);
	else fail(name, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
async function expectThrows(name: string, fn: () => unknown): Promise<void> {
	try {
		await fn();
		fail(name, 'expected an error to be thrown, but call resolved');
	} catch {
		pass(name);
	}
}

// ── Deterministic clock (composite.ts uses Date.now() directly) ──
let clock = 1_700_000_000_000;
const realDateNow = Date.now;
Date.now = () => clock;

// ── Mock upstream helper: a structurally-valid PriceProvider that
//    records its call count and delegates to a responder closure
//    (which may return a quote or throw). ──
type Spy = PriceProvider & { calls: number };
function spy(name: string, respond: (symbol: PricedSymbol) => PriceQuote): Spy {
	const s: Spy = {
		name,
		calls: 0,
		async getPriceUsd(symbol: PricedSymbol): Promise<PriceQuote> {
			s.calls++;
			return respond(symbol);
		}
	};
	return s;
}
function q(symbol: PricedSymbol, usd: number, source = 'mock'): PriceQuote {
	return { symbol, usd, fetchedAt: Date.now(), source };
}

async function main(): Promise<void> {
	console.log('\n── composite-price-provider smoke (cp197 wiring-audit guard) ──\n');

	// 1. name
	{
		const p = createCompositeProvider({ upstreams: [spy('a', (s) => q(s, 1, 'a'))] });
		expectEq("provider name is 'composite'", p.name, 'composite');
	}

	// 2. empty upstreams → throws
	{
		const cfg = { upstreams: [] } as unknown as CompositeProviderConfig;
		try {
			createCompositeProvider(cfg);
			fail('empty upstreams → constructor throws', 'no error thrown for empty upstreams');
		} catch {
			pass('empty upstreams → constructor throws');
		}
	}

	// 3. first VALID upstream wins; later upstream not called
	{
		const a = spy('a', (s) => q(s, 100, 'a'));
		const b = spy('b', (s) => q(s, 200, 'b'));
		const p = createCompositeProvider({ upstreams: [a, b] });
		const res = await p.getPriceUsd('BTC');
		expectEq('first valid upstream wins (source)', res.source, 'a');
		expectEq('first valid upstream wins (usd)', res.usd, 100);
		expectEq('winning upstream queried exactly once', a.calls, 1);
		expectEq('later upstream not queried when first wins', b.calls, 0);
	}

	// 4. invalid quotes are rejected → fall through to next valid upstream
	{
		const invalids: ReadonlyArray<readonly [string, number]> = [
			['usd === 0', 0],
			['usd < 0', -5],
			['usd === NaN', NaN],
			['usd === Infinity', Infinity]
		];
		for (const [label, badUsd] of invalids) {
			const bad = spy('bad', (s) => q(s, badUsd, 'bad'));
			const good = spy('good', (s) => q(s, 99, 'good'));
			const p = createCompositeProvider({ upstreams: [bad, good] });
			const res = await p.getPriceUsd('BTC');
			expectEq(`rejects invalid quote (${label}) and falls through`, res.source, 'good');
		}
		// non-number usd (defends against untyped upstreams)
		const nonNum = spy('nonnum', (s) => ({
			symbol: s,
			usd: '5' as unknown as number,
			fetchedAt: Date.now(),
			source: 'nonnum'
		}));
		const good = spy('good', (s) => q(s, 99, 'good'));
		const p = createCompositeProvider({ upstreams: [nonNum, good] });
		const res = await p.getPriceUsd('BTC');
		expectEq('rejects non-number usd and falls through', res.source, 'good');
	}

	// 5. an upstream that throws is caught → chain continues
	{
		const boom = spy('boom', () => {
			throw new Error('upstream down');
		});
		const good = spy('good', (s) => q(s, 42, 'good'));
		const p = createCompositeProvider({ upstreams: [boom, good] });
		const res = await p.getPriceUsd('BTC');
		expectEq('throwing upstream is caught, chain continues', res.source, 'good');
		expectEq('throwing upstream was actually attempted', boom.calls, 1);
	}

	// 6. all upstreams fail with no cache → propagates an error
	{
		const d1 = spy('d1', () => {
			throw new Error('x');
		});
		const d2 = spy('d2', () => {
			throw new Error('y');
		});
		const p = createCompositeProvider({ upstreams: [d1, d2] });
		await expectThrows('all upstreams fail + no cache → throws', () => p.getPriceUsd('BTC'));
		expectEq('every upstream attempted before throwing', d1.calls + d2.calls, 2);
	}

	// 7. per-symbol cache hit within TTL: upstream called once; cached
	//    quote returned with its ORIGINAL fetchedAt (not refreshed)
	{
		const up = spy('up', (s) => q(s, 50, 'up'));
		const p = createCompositeProvider({ upstreams: [up], cacheTtlMs: 60_000 });
		const first = await p.getPriceUsd('BTC');
		clock += 1_000; // advance 1s, well within the 60s TTL
		const second = await p.getPriceUsd('BTC');
		expectEq('within-TTL re-read served from cache (one upstream call)', up.calls, 1);
		expectEq('cached quote preserves original fetchedAt (not refreshed)', second.fetchedAt, first.fetchedAt);
		expectEq('cached quote preserves usd', second.usd, first.usd);

		// 8. per-symbol isolation: XMR is NOT served from the BTC cache
		const xmr = await p.getPriceUsd('XMR');
		expectEq('cache is per-symbol: XMR triggers its own upstream call', up.calls, 2);
		expectEq('per-symbol: XMR quote is for XMR', xmr.symbol, 'XMR');

		// 9. after TTL expiry, the upstream is queried again
		clock += 120_000; // now far past the 60s TTL for BTC
		const third = await p.getPriceUsd('BTC');
		expectEq('after TTL expiry the upstream is re-queried', up.calls, 3);
		expectEq('post-expiry quote carries a fresh fetchedAt', third.fetchedAt, clock);
	}

	// 10. stale-cache serving: prime cache, expire it, then make the
	//     upstream fail → the stale quote is served rather than throwing
	{
		let mode: 'ok' | 'fail' = 'ok';
		const flaky = spy('flaky', (s) => {
			if (mode === 'fail') throw new Error('down');
			return q(s, 77, 'flaky');
		});
		const p = createCompositeProvider({ upstreams: [flaky], cacheTtlMs: 1_000 });
		const primed = await p.getPriceUsd('XMR');
		clock += 5_000; // past the 1s TTL → next read is a cache miss
		mode = 'fail';
		const stale = await p.getPriceUsd('XMR');
		expectEq('stale cache served when all upstreams fail', stale.usd, 77);
		expectEq('stale-served quote keeps its original fetchedAt', stale.fetchedAt, primed.fetchedAt);
	}

	const total = passed + failed;
	console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
	if (failed > 0) {
		console.error('\ncomposite-price-provider smoke FAILED');
		process.exit(1);
	}
	console.log(`✓ all ${total} composite-price-provider scenarios passed`);
}

main()
	.catch((err) => {
		console.error('composite-price-provider smoke crashed:', err);
		process.exitCode = 1;
	})
	.finally(() => {
		Date.now = realDateNow;
	});
