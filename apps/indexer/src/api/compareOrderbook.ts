/**
 * Morphit indexer — another instance's orderbook, fetched for /compare
 * (v1.20.2).
 *
 * Route (mounted at /v1/compare):
 *   GET /orderbook?origin=<origin>   that instance's first orderbook page
 *
 * THE PROBLEM. The /compare page diffs this instance's orderbook against a
 * peer's, to catch an instance hiding orders. It fetched the peer's
 * `/v1/orderbook` from the visitor's browser, and every instance's
 * Content-Security-Policy `connect-src` allows only 'self' and the Blurt RPC
 * nodes — so the browser refused the request before it left ("Failed to
 * fetch": morphit.io → timeapp, 2026-10-01). Since v1.20.0 put that policy on
 * the BunkerWeb boxes too, compare worked nowhere. Widening `connect-src` to
 * "every instance" is not a list a static header can hold, would put the
 * visitor's IP in the peer's logs, and cannot reach a hidden peer from a
 * clearnet page anyway.
 *
 * THE DESIGN — the pairing forward's (pairingForward.ts), read-only. The page
 * asks its OWN instance (same origin); this indexer fetches the peer's page
 * over the peer's hidden address when it published one, over the pinned
 * clearnet path otherwise, never over clearnet from a hidden-only node. The
 * peer sees this instance, never the visitor.
 *
 * WHAT MAKES THIS NOT AN OPEN PROXY (the pairing forward's rules):
 *   - the target must be a REGISTERED federation instance (`known_instances`
 *     / its operator's published hidden addresses; probe `mismatch` rows
 *     excluded) — anything else is refused before any network activity;
 *   - what is dialled is the instance's REGISTERED addresses, and only ONE
 *     path: `/v1/orderbook?limit=100`;
 *   - clearnet: https only, every resolved address public, the connection
 *     pinned to it, no redirects, the body read bounded (federationProbe
 *     fetchJson); hidden: the hidden transport, no redirects, bounded;
 *   - per-attempt timeouts and an overall deadline; per-client rate limit
 *     (the `list` tier, main.ts), per-target and instance-wide budgets, an
 *     in-flight cap; one fetch per peer at a time (concurrent asks share it)
 *     and a 30-second cache, so a crowd on /compare costs the peer one
 *     request per 30 s;
 *   - the answer is RE-BUILT from validated fields: the `items` array of
 *     objects that each carry a string account and permlink (at most 100),
 *     `indexed_block`, `next_cursor` — the shape of `/v1/orderbook`
 *     (OrderbookResponse). Nothing else the peer sends is passed on.
 *
 * PRIVACY. Nothing here logs an address or a target.
 */
import { Hono, type Context } from 'hono';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import { hiddenNetworkOf, isProxyUnavailable } from '@morphit/hidden-transport';
import { clearnetRefused } from '@morphit/hidden-transport/router';

import { errorBody } from '$api/shared';
import {
	ForwardBudget,
	parsePairingTarget,
	resolvePairingTarget,
	type SelfAddresses
} from '$api/pairingForward';
import type { FastFederationDb, FastPeerAddress } from '$indexer/chatFastFederation';
import { fetchJson as federationFetchJson } from '$indexer/federationProbe';
import { fetchJsonViaHiddenService } from '$indexer/hiddenServiceFetch';
import { logger } from '$log';

const log = logger('compare-orderbook');

/** One page, as the compare page asks of its own instance. */
export const PEER_PAGE_LIMIT = 100;
/** ~3 KB an order on morphit.io (2026-10-01, with profile metadata): 100
 *  orders is ~300 KB, over the probe's 256 KB cap. */
export const PEER_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const HIDDEN_TIMEOUT_MS = 45_000;
export const CLEARNET_TIMEOUT_MS = 12_000;
const OVERALL_DEADLINE_MS = 50_000;
const UNVERIFIED_HIDDEN_TIMEOUT_MS = 15_000;
const UNVERIFIED_CLEARNET_TIMEOUT_MS = 6_000;
const UNVERIFIED_DEADLINE_MS = 20_000;
/** A peer's page is reused this long. */
export const CACHE_MS = 30_000;
const USER_AGENT = 'morphit-indexer/compare';

/** The peer's `/v1/orderbook` page (packages/indexer-client OrderbookResponse:
 *  `items`, `next_cursor`, `indexed_block`). */
export interface PeerOrderbookPage {
	readonly items: readonly Record<string, unknown>[];
	readonly indexed_block: number | null;
	readonly next_cursor: string | null;
}

/** The peer's answer re-built from validated fields, or null. PURE. */
export function validatePeerOrderbook(body: unknown): PeerOrderbookPage | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const b = body as Record<string, unknown>;
	if (!Array.isArray(b.items)) return null;
	const items: Record<string, unknown>[] = [];
	for (const o of b.items) {
		if (items.length >= PEER_PAGE_LIMIT) break;
		if (typeof o !== 'object' || o === null || Array.isArray(o)) continue;
		const r = o as Record<string, unknown>;
		if (typeof r.account !== 'string' || typeof r.permlink !== 'string') continue;
		if (r.account.length === 0 || r.account.length > 32) continue;
		if (r.permlink.length === 0 || r.permlink.length > 256) continue;
		items.push(r);
	}
	const ib = b.indexed_block;
	const nc = b.next_cursor;
	return {
		items,
		indexed_block: typeof ib === 'number' && Number.isSafeInteger(ib) && ib >= 0 ? ib : null,
		next_cursor: typeof nc === 'string' && nc.length > 0 && nc.length <= 512 ? nc : null
	};
}

export type GetJson = (
	url: string,
	hidden: boolean,
	proxies: HiddenServiceProxyConfig,
	timeoutMs: number
) => Promise<unknown>;

const defaultGetJson: GetJson = (url, hidden, proxies, timeoutMs) =>
	hidden
		? fetchJsonViaHiddenService<unknown>(url, proxies, timeoutMs, { maxBytes: PEER_PAGE_MAX_BYTES })
		: federationFetchJson<unknown>(url, {
				timeoutMs,
				maxBytes: PEER_PAGE_MAX_BYTES,
				userAgent: USER_AGENT
			});

export type PeerPageOutcome =
	| { readonly kind: 'page'; readonly page: PeerOrderbookPage }
	| { readonly kind: 'bad_answer' }
	| { readonly kind: 'unreachable' };

/**
 * The first address that ANSWERS decides (the pairing forward's rule): a
 * local transport fault (no Tor daemon) moves on to the next address; a peer
 * that could not be reached over its hidden address is not re-tried over
 * clearnet; never clearnet from a hidden-only node.
 */
export async function fetchPeerOrderbook(
	addresses: readonly FastPeerAddress[],
	deps: {
		readonly proxies: HiddenServiceProxyConfig;
		readonly getJson: GetJson;
		readonly hiddenTimeoutMs: number;
		readonly clearnetTimeoutMs: number;
		readonly deadlineMs: number;
		readonly now: () => number;
	}
): Promise<PeerPageOutcome> {
	const deadline = deps.now() + deps.deadlineMs;
	for (const addr of addresses) {
		const left = deadline - deps.now();
		if (left <= 0) break;
		const hiddenUrl = hiddenNetworkOf(addr.origin) !== null;
		if (addr.hidden && !hiddenUrl) continue;
		if (!addr.hidden && clearnetRefused()) continue;
		// The ONE path; a root-absolute path discards any path on the origin.
		const url = new URL(`/v1/orderbook?limit=${PEER_PAGE_LIMIT}`, addr.origin).toString();
		try {
			const body = await deps.getJson(
				url,
				addr.hidden,
				deps.proxies,
				Math.min(addr.hidden ? deps.hiddenTimeoutMs : deps.clearnetTimeoutMs, left)
			);
			const page = validatePeerOrderbook(body);
			return page === null ? { kind: 'bad_answer' } : { kind: 'page', page };
		} catch (err) {
			if (isProxyUnavailable(err)) {
				log.info('compare_local_transport_fault', {
					network: hiddenNetworkOf(addr.origin) ?? 'clearnet'
				});
				continue;
			}
			log.info('compare_peer_unreachable', { network: hiddenNetworkOf(addr.origin) ?? 'clearnet' });
			return { kind: 'unreachable' };
		}
	}
	return { kind: 'unreachable' };
}

export interface CompareOrderbookDeps {
	readonly db: FastFederationDb;
	readonly self: SelfAddresses;
	readonly proxies: HiddenServiceProxyConfig;
	readonly getJson?: GetJson;
	readonly budget?: ForwardBudget;
	readonly now?: () => number;
	readonly hiddenTimeoutMs?: number;
	readonly clearnetTimeoutMs?: number;
	/** Tests: called when a request joins a fetch already in flight. */
	readonly onJoin?: (key: string) => void;
}

function fail(c: Context, status: 400 | 404 | 429 | 502, reason: string) {
	const code =
		status === 404
			? 'not_found'
			: status === 429
				? 'rate_limited'
				: status === 502
					? 'internal'
					: 'bad_request';
	return c.json({ ...errorBody(code, reason), reason }, status);
}

export function compareOrderbookRoute(deps: CompareOrderbookDeps): Hono {
	const app = new Hono();
	const now = deps.now ?? Date.now;
	const getJson = deps.getJson ?? defaultGetJson;
	// One peer: a fetch at a time (shared below) and at most 6 a minute; all
	// peers together: 120 a minute, 16 at once.
	const budget =
		deps.budget ??
		new ForwardBudget({
			perTargetPerMin: 6,
			globalPerMin: 120,
			inFlightMax: 16,
			perTargetInFlightMax: 1,
			unverifiedInFlightMax: 4
		});
	const cache = new Map<string, { at: number; page: PeerOrderbookPage }>();
	const inFlight = new Map<string, Promise<PeerPageOutcome>>();

	app.use('*', async (c, next) => {
		await next();
		c.header('cache-control', 'no-store');
	});

	app.get('/orderbook', async (c) => {
		const target = parsePairingTarget(c.req.query('origin'));
		if (target === null) return fail(c, 400, 'bad_target');
		const resolved = await resolvePairingTarget(deps.db, target, deps.self, deps.proxies);
		if (resolved.kind === 'unknown') return fail(c, 404, 'unknown_instance');
		if (resolved.kind === 'self') return fail(c, 400, 'same_instance');
		const { key, healthy } = resolved;

		const hit = cache.get(key);
		if (hit !== undefined && now() - hit.at < CACHE_MS) {
			return c.json({ status: 'ok', origin: key, ...hit.page });
		}
		// Expired entries are dropped as they are met; the map holds at most
		// one entry per registered instance.
		if (hit !== undefined) cache.delete(key);

		let pending = inFlight.get(key);
		if (pending !== undefined) deps.onJoin?.(key);
		if (pending === undefined) {
			const slot = budget.take(key, now(), healthy);
			if (slot !== 'ok') {
				c.header('retry-after', '30');
				return fail(c, 429, 'compare_rate_limited');
			}
			pending = (async () => {
				try {
					return await fetchPeerOrderbook(resolved.addresses, {
						proxies: deps.proxies,
						getJson,
						hiddenTimeoutMs: healthy
							? (deps.hiddenTimeoutMs ?? HIDDEN_TIMEOUT_MS)
							: Math.min(deps.hiddenTimeoutMs ?? HIDDEN_TIMEOUT_MS, UNVERIFIED_HIDDEN_TIMEOUT_MS),
						clearnetTimeoutMs: healthy
							? (deps.clearnetTimeoutMs ?? CLEARNET_TIMEOUT_MS)
							: Math.min(
									deps.clearnetTimeoutMs ?? CLEARNET_TIMEOUT_MS,
									UNVERIFIED_CLEARNET_TIMEOUT_MS
								),
						deadlineMs: healthy ? OVERALL_DEADLINE_MS : UNVERIFIED_DEADLINE_MS,
						now
					});
				} finally {
					budget.release(key, healthy);
					inFlight.delete(key);
				}
			})();
			inFlight.set(key, pending);
		}
		const out = await pending;
		if (out.kind === 'unreachable') return fail(c, 502, 'target_unreachable');
		if (out.kind === 'bad_answer') return fail(c, 502, 'target_bad_answer');
		cache.set(key, { at: now(), page: out.page });
		return c.json({ status: 'ok', origin: key, ...out.page });
	});

	return app;
}
