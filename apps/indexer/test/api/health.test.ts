/**
 * Tests for /v1/health.
 *
 * Exercises the endpoint's HTTP response shape without standing
 * up Postgres, the chain RPC, or the full Poller. The test builds
 * a minimal in-process Hono app around `healthRoute()` and pokes
 * it with fetch-style requests.
 *
 * Coverage:
 *   - Baseline shape (status/version/blocks/lag/stale fields)
 *   - `degraded` status when lag exceeds the configured threshold
 *   - Verbose diagnostics included when config.verboseHealth=true
 *   - Verbose diagnostics included when ?verbose=1 is on the URL
 *   - Verbose diagnostics NOT included by default
 *   - Explorer diagnostics reflect CircuitBreaker state
 *   - Response has cache-control: no-store
 */

import { describe, expect, it } from 'vitest';

import { healthRoute } from '$api/health';
import type { EndpointState } from '@morphit/rpc-pool';
import type { Config } from '$config';
import type { Poller } from '$indexer/poller';
import type { BlurtPriceSource } from '$indexer/price/source';

// ─── Fakes ──────────────────────────────────────────────────────

/**
 * Build a Config sufficient for the health endpoint. Only fields
 * used by `healthRoute()` matter; everything else is a best-effort
 * type fill that the endpoint never reads.
 */
function fakeConfig(overrides: Partial<Config> = {}): Config {
	// The full Config type is large; most fields are ignored by
	// healthRoute. Start from a minimal object and let `as Config`
	// paper over the fields we don't touch.
	return {
		staleLagThreshold: 10,
		verboseHealth: false,
		...overrides
	} as unknown as Config;
}

/**
 * Build a Poller stand-in with the minimal surface healthRoute
 * uses: getStatus() + explorerHealthSnapshot.  cp166 — the old
 * shared CircuitBreaker was replaced by per-verifier EndpointPool
 * instances; the poller now merges their snapshots into one list.
 * For tests, we inject the merged list directly so the diagnostic
 * output shape can be exercised without spinning up real verifiers.
 */
function fakePoller(
	opts: {
		chainHeadBlock?: number;
		indexedBlock?: number;
		lastError?: string | null;
		lastErrorAt?: Date | null;
		startedAt?: Date;
		explorerSnapshot?: EndpointState[];
		rpcSnapshot?: EndpointState[];
	} = {}
): Poller {
	const snapshot = opts.explorerSnapshot ?? [];
	const rpcSnapshot = opts.rpcSnapshot ?? [];
	return {
		getStatus() {
			return {
				running: true,
				chainHeadBlock: opts.chainHeadBlock ?? 1_000_000,
				indexedBlock: opts.indexedBlock ?? 1_000_000,
				startedAt: opts.startedAt ?? new Date('2026-04-20T12:00:00Z'),
				lastError: opts.lastError ?? null,
				lastErrorAt: opts.lastErrorAt ?? null
			};
		},
		get explorerHealthSnapshot(): readonly EndpointState[] {
			return snapshot;
		},
		get rpcEndpointSnapshot(): readonly EndpointState[] {
			return rpcSnapshot;
		},
		getOperatorBalanceState() {
			// Empty map = no monitored accounts configured. Tests that
			// exercise operator_balances rendering should pass a custom
			// poller; the default fake returns empty so the
			// operator_balances array is [] in the health response.
			return new Map();
		}
	} as unknown as Poller;
}

/**
 * Minimal BlurtPriceSource stand-in. Lets tests control exactly
 * what the `diagnostics.price` surface reports.
 */
function fakePriceSource(
	opts: {
		price?: number;
		source?: string;
		updatedAt?: Date;
		stale?: boolean;
	} = {}
): BlurtPriceSource {
	const price = opts.price ?? 0.002;
	const source = opts.source ?? 'test_static';
	const updatedAt = opts.updatedAt ?? new Date('2026-04-20T11:55:00Z');
	const stale = opts.stale ?? false;
	return {
		current: () => price,
		currentDetailed: () => ({
			price,
			source,
			updated_at: updatedAt,
			stale
		}),
		start: () => undefined,
		stop: () => undefined
	};
}

// ─── Helpers ────────────────────────────────────────────────────

async function getHealth(
	cfg: Config,
	poller: Poller,
	query = '',
	priceSource: BlurtPriceSource | null = fakePriceSource()
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
	const app = healthRoute(cfg, poller, priceSource);
	const url = `http://localhost/${query ? '?' + query : ''}`;
	const res = await app.request(url);
	const body = (await res.json()) as Record<string, unknown>;
	return { status: res.status, body, headers: res.headers };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('healthRoute — baseline shape', () => {
	it('returns the expected top-level fields', async () => {
		const { status, body } = await getHealth(fakeConfig(), fakePoller());
		expect(status).toBe(200);
		expect(body).toMatchObject({
			status: 'ok',
			uptime_sec: expect.any(Number),
			chain_head_block: expect.any(Number),
			indexed_block: expect.any(Number),
			lag_blocks: expect.any(Number),
			lag_blocks_note: expect.any(String),
			stale: expect.any(Boolean),
			version: expect.any(String)
		});
	});

	it('reports ok status when lag is within threshold', async () => {
		const { body } = await getHealth(
			fakeConfig({ staleLagThreshold: 10 }),
			fakePoller({ chainHeadBlock: 1000, indexedBlock: 995 })
		);
		expect(body.status).toBe('ok');
		expect(body.stale).toBe(false);
		expect(body.lag_blocks).toBe(5);
	});

	it('lag_blocks_note reflects the configured threshold and 3s block time', async () => {
		const { body } = await getHealth(
			fakeConfig({ staleLagThreshold: 10 }),
			fakePoller({ chainHeadBlock: 1000, indexedBlock: 995 })
		);
		// threshold 10 → "0–10 is normal (~30s behind; Blurt makes a block every 3s)"
		expect(body.lag_blocks_note).toContain('10 is normal');
		expect(body.lag_blocks_note).toContain('30s behind');
		expect(body.lag_blocks_note).toContain('every 3s');
	});

	it('reports degraded status when lag exceeds threshold', async () => {
		const { body } = await getHealth(
			fakeConfig({ staleLagThreshold: 5 }),
			fakePoller({ chainHeadBlock: 1000, indexedBlock: 900 })
		);
		expect(body.status).toBe('degraded');
		expect(body.stale).toBe(true);
		expect(body.lag_blocks).toBe(100);
	});

	it('clamps negative lag to zero when indexed is ahead of head', async () => {
		// Rare but possible mid-poll: the indexer already applied a
		// block that the cached chain-head value hasn't yet caught up
		// to. Shouldn't produce a nonsense negative lag.
		const { body } = await getHealth(
			fakeConfig(),
			fakePoller({ chainHeadBlock: 900, indexedBlock: 1000 })
		);
		expect(body.lag_blocks).toBe(0);
	});

	it('sets cache-control: no-store', async () => {
		const { headers } = await getHealth(fakeConfig(), fakePoller());
		expect(headers.get('cache-control')).toBe('no-store');
	});

	it('includes a non-verbose price_feed summary when a price source is present', async () => {
		// cp365 — `morphit-ops health` reads this without the verbose
		// token.  Nothing sensitive: the price is already public via
		// /v1/listing-fee.
		const { body } = await getHealth(fakeConfig(), fakePoller());
		expect(body.price_feed).toMatchObject({
			enabled: true,
			blurt_fiat: 0.002,
			source: 'test_static',
			stale: false
		});
	});

	it('reports price_feed.enabled=false when the feed is disabled (null source)', async () => {
		const { body } = await getHealth(fakeConfig(), fakePoller(), '', null);
		expect(body.price_feed).toEqual({ enabled: false });
	});

	it('price_feed.stale reflects a stale upstream (static-floor fallback)', async () => {
		const { body } = await getHealth(
			fakeConfig(),
			fakePoller(),
			'',
			fakePriceSource({ stale: true, price: 0.0015, source: 'static_floor' })
		);
		expect(body.price_feed).toMatchObject({
			enabled: true,
			stale: true,
			source: 'static_floor'
		});
	});
});

describe('healthRoute — verbose diagnostics', () => {
	it('omits diagnostics by default', async () => {
		const { body } = await getHealth(fakeConfig(), fakePoller());
		expect(body.diagnostics).toBeUndefined();
	});

	// Audit 2026-05 finding NEW-9-8: verbose mode now requires
	// BOTH config.verboseHealth=true AND ?verbose=1.  Pre-fix,
	// any caller passing ?verbose=1 got the full diagnostics
	// block — which leaks below-threshold balance signal to a
	// public attacker timing a drain attempt.

	it('config.verboseHealth=true alone is not enough — requires ?verbose=1 too', async () => {
		const { body } = await getHealth(fakeConfig({ verboseHealth: true }), fakePoller());
		expect(body.diagnostics).toBeUndefined();
	});

	it('?verbose=1 alone is not enough — requires config.verboseHealth=true too', async () => {
		const { body } = await getHealth(fakeConfig(), fakePoller(), 'verbose=1');
		expect(body.diagnostics).toBeUndefined();
	});

	it('includes diagnostics when BOTH config.verboseHealth=true AND ?verbose=1', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller(),
			'verbose=1'
		);
		expect(body.diagnostics).toBeDefined();
	});

	it('ignores ?verbose values other than "1"', async () => {
		// Defense-in-depth: we want a truthy check, not "any non-empty
		// string". Right now the code checks `=== '1'`, this test pins
		// that behavior.
		for (const bad of ['true', 'yes', '0', '']) {
			const { body } = await getHealth(
				fakeConfig({ verboseHealth: true }),
				fakePoller(),
				`verbose=${encodeURIComponent(bad)}`
			);
			expect(body.diagnostics).toBeUndefined();
		}
	});

	it('diagnostics object has the expected shape', async () => {
		const at = new Date('2026-04-20T13:00:00Z');
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({
				lastError: 'RPC timeout',
				lastErrorAt: at,
				startedAt: new Date('2026-04-20T12:00:00Z')
			}),
			'verbose=1'
		);
		const d = body.diagnostics as Record<string, unknown>;
		expect(d).toMatchObject({
			last_error: 'RPC timeout',
			last_error_at: at.toISOString(),
			started_at: '2026-04-20T12:00:00.000Z',
			explorers: expect.any(Array)
		});
	});

	it('diagnostics.last_error_at is null when there has been no error', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({ lastError: null, lastErrorAt: null }),
			'verbose=1'
		);
		const d = body.diagnostics as Record<string, unknown>;
		expect(d.last_error).toBeNull();
		expect(d.last_error_at).toBeNull();
	});
});

describe('healthRoute — explorer diagnostics reflect EndpointPool state', () => {
	// cp166 — was driven by a real CircuitBreaker; the breaker
	// class is gone (per-verifier EndpointPool replaces it).
	// Diagnostic state is now sourced from the poller's
	// `explorerHealthSnapshot` accessor which is a merged list of
	// EndpointState records across the BTC and XMR verifiers.
	// Tests construct synthetic EndpointState objects directly.

	function ep(
		url: string,
		overrides: Partial<EndpointState> = {}
	): EndpointState {
		return {
			url,
			ewmaLatencyMs: null,
			consecutiveFailures: 0,
			cooldownUntil: 0,
			lastSuccessAt: 0,
			...overrides
		};
	}

	it('reports an empty explorers list when no endpoints are tracked', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({ explorerSnapshot: [] }),
			'verbose=1'
		);
		const d = body.diagnostics as { explorers: unknown[] };
		expect(d.explorers).toEqual([]);
	});

	it('reports closed state for endpoints with no failures or cooldown', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({
				explorerSnapshot: [
					ep('https://btc.example.com', {
						ewmaLatencyMs: 120,
						lastSuccessAt: Date.now() - 5_000
					})
				]
			}),
			'verbose=1'
		);
		const d = body.diagnostics as {
			explorers: Array<{
				url: string;
				state: string;
				consecutive_failures: number;
				cooldown_remaining_ms: number;
				ewma_latency_ms: number | null;
			}>;
		};
		expect(d.explorers).toHaveLength(1);
		expect(d.explorers[0]!.url).toBe('https://btc.example.com');
		expect(d.explorers[0]!.state).toBe('closed');
		expect(d.explorers[0]!.consecutive_failures).toBe(0);
		expect(d.explorers[0]!.ewma_latency_ms).toBe(120);
	});

	it('reports open state when an endpoint is in active cooldown', async () => {
		const cooldownFor = 30_000;
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({
				explorerSnapshot: [
					ep('https://xmr.example.com', {
						consecutiveFailures: 5,
						cooldownUntil: Date.now() + cooldownFor
					})
				]
			}),
			'verbose=1'
		);
		const d = body.diagnostics as {
			explorers: Array<{ url: string; state: string; consecutive_failures: number; cooldown_remaining_ms: number }>;
		};
		expect(d.explorers[0]!.state).toBe('open');
		expect(d.explorers[0]!.consecutive_failures).toBe(5);
		expect(d.explorers[0]!.cooldown_remaining_ms).toBeGreaterThan(0);
	});

	it('reports half_open state for past-cooldown endpoint with prior failures', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({
				explorerSnapshot: [
					ep('https://recovering.example.com', {
						consecutiveFailures: 2,
						// Cooldown deadline has passed — endpoint is
						// eligible for retry but hasn't succeeded yet.
						cooldownUntil: Date.now() - 1_000
					})
				]
			}),
			'verbose=1'
		);
		const d = body.diagnostics as {
			explorers: Array<{ state: string; cooldown_remaining_ms: number }>;
		};
		expect(d.explorers[0]!.state).toBe('half_open');
		expect(d.explorers[0]!.cooldown_remaining_ms).toBe(0);
	});

	// ── beta5: the Blurt RPC pool (block feed) exposed on /v1/health ──
	it('reports compact rpc_endpoints_healthy / _total on the PUBLIC body', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: false }),
			fakePoller({
				rpcSnapshot: [
					ep('https://rpc.blurt.blog', { lastSuccessAt: Date.now() - 1_000 }),
					ep('https://rpc.beblurt.com', { lastSuccessAt: Date.now() - 2_000 }),
					// one endpoint in active cooldown = not currently healthy
					ep('https://rpc.dead.example', {
						consecutiveFailures: 3,
						cooldownUntil: Date.now() + 30_000
					})
				]
			})
		);
		// Available even without verbose (this is the at-a-glance triage signal).
		expect(body.rpc_endpoints_total).toBe(3);
		expect(body.rpc_endpoints_healthy).toBe(2);
		// Per-endpoint detail must NOT leak onto the public body.
		expect(body.diagnostics).toBeUndefined();
	});

	it('reports 0 healthy when every RPC endpoint is cooled down (the firefight case)', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: false }),
			fakePoller({
				rpcSnapshot: [
					ep('https://rpc.a.example', { cooldownUntil: Date.now() + 10_000 }),
					ep('https://rpc.b.example', { cooldownUntil: Date.now() + 10_000 })
				]
			})
		);
		expect(body.rpc_endpoints_total).toBe(2);
		expect(body.rpc_endpoints_healthy).toBe(0);
	});

	it('exposes full rpc_endpoints detail (url/state/latency) in the verbose block', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({
				rpcSnapshot: [
					ep('https://rpc.blurt.blog', {
						ewmaLatencyMs: 95,
						lastSuccessAt: Date.now() - 4_000
					}),
					ep('https://rpc.dead.example', {
						consecutiveFailures: 4,
						cooldownUntil: Date.now() + 20_000
					})
				]
			}),
			'verbose=1'
		);
		const d = body.diagnostics as {
			rpc_endpoints: Array<{
				url: string;
				state: string;
				consecutive_failures: number;
				cooldown_remaining_ms: number;
				ewma_latency_ms: number | null;
				last_success_age_s: number | null;
			}>;
		};
		expect(d.rpc_endpoints).toHaveLength(2);
		const live = d.rpc_endpoints.find((e) => e.url === 'https://rpc.blurt.blog')!;
		expect(live.state).toBe('closed');
		expect(live.ewma_latency_ms).toBe(95);
		expect(live.last_success_age_s).toBeGreaterThanOrEqual(3);
		const dead = d.rpc_endpoints.find((e) => e.url === 'https://rpc.dead.example')!;
		expect(dead.state).toBe('open');
		expect(dead.consecutive_failures).toBe(4);
		expect(dead.cooldown_remaining_ms).toBeGreaterThan(0);
		expect(dead.last_success_age_s).toBeNull();
	});

	it('exposes cooldown_remaining_ms as a non-negative number', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({
				explorerSnapshot: [
					ep('https://xmr.example.com', {
						consecutiveFailures: 5,
						cooldownUntil: Date.now() + 60_000
					})
				]
			}),
			'verbose=1'
		);
		const d = body.diagnostics as {
			explorers: Array<{ cooldown_remaining_ms: number }>;
		};
		expect(d.explorers[0]!.cooldown_remaining_ms).toBeGreaterThanOrEqual(0);
	});

	it('tracks multiple explorers independently', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller({
				explorerSnapshot: [
					ep('https://a.example.com', { ewmaLatencyMs: 50, lastSuccessAt: Date.now() }),
					ep('https://b.example.com', {
						consecutiveFailures: 5,
						cooldownUntil: Date.now() + 30_000
					})
				]
			}),
			'verbose=1'
		);
		const d = body.diagnostics as {
			explorers: Array<{ url: string; state: string }>;
		};
		const byUrl = Object.fromEntries(d.explorers.map((e) => [e.url, e.state]));
		expect(byUrl['https://a.example.com']).toBe('closed');
		expect(byUrl['https://b.example.com']).toBe('open');
	});
});

describe('healthRoute — price source diagnostics', () => {
	it('is omitted from the non-verbose body', async () => {
		const { body } = await getHealth(
			fakeConfig(),
			fakePoller(),
			'',
			fakePriceSource({ price: 0.005 })
		);
		expect(body.diagnostics).toBeUndefined();
	});

	it('reports live upstream source name, price, and updated_at', async () => {
		const updatedAt = new Date('2026-04-20T11:55:00Z');
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller(),
			'verbose=1',
			fakePriceSource({
				price: 0.00423,
				source: 'klingex',
				updatedAt,
				stale: false
			})
		);
		const d = body.diagnostics as { price: Record<string, unknown> };
		// Use toMatchObject so the test tolerates additional fields
		// the code may add (e.g. `enabled: true` was added when
		// the price feed gained an opt-in flag).
		expect(d.price).toMatchObject({
			blurt_usd: 0.00423,
			source: 'klingex',
			updated_at: updatedAt.toISOString(),
			stale: false
		});
	});

	it('reports stale=true when the price source says so', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller(),
			'verbose=1',
			fakePriceSource({ stale: true })
		);
		const d = body.diagnostics as { price: { stale: boolean } };
		expect(d.price.stale).toBe(true);
	});

	it('reports the static_floor source name when no feed has served', async () => {
		const { body } = await getHealth(
			fakeConfig({ verboseHealth: true }),
			fakePoller(),
			'verbose=1',
			fakePriceSource({ source: 'static_floor', stale: true })
		);
		const d = body.diagnostics as { price: { source: string } };
		expect(d.price.source).toBe('static_floor');
	});

	it('ignores verbose query param value other than "1" for price too', async () => {
		// Regression check: the existing "ignore verbose=true/yes/0"
		// test covered the whole diagnostics object. This pins the
		// expectation that the price sub-field follows the same rule
		// as explorers + last_error — no sneak-leak.
		const { body } = await getHealth(
			fakeConfig(),
			fakePoller(),
			'verbose=true',
			fakePriceSource({ price: 0.005 })
		);
		expect(body.diagnostics).toBeUndefined();
	});
});
