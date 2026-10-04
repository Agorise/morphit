/**
 * Morphit frontend — how long to wait, given what the request has to cross.
 *
 * WHY THIS EXISTS
 * Every timeout in the browser was sized for clearnet: 8s for an indexer API
 * call, 15s for a chain read. Those are good numbers when the request is a
 * TCP connection to a host with an A record. They are the wrong numbers
 * entirely when the request has to build a Tor circuit or an I2P tunnel first,
 * which routinely takes 30-60 seconds on a cold connection — a fact the
 * server side of this codebase already knows and accounts for (the indexer and
 * relay both raise their own RPC ceilings to 60s for a hidden endpoint).
 *
 * The result was that on a hidden-only instance such as morphitlat the browser
 * abandoned nearly everything it asked for, and the failures did not look like
 * timeouts. An aborted chat-identity read surfaced as the peer's key being
 * unverifiable, which pub-pinning reports as TAMPERING. An aborted orderbook
 * comparison against a `.b32.i2p` peer looked like that instance being
 * unreachable. Each symptom sent whoever hit it looking somewhere else
 * entirely.
 *
 * Two hops can be hidden and either is enough to need the longer budget:
 *   • the page's OWN origin — a visitor reading morphitlat over I2P crosses a
 *     tunnel for every same-origin API call;
 *   • the TARGET origin — a request aimed at a hidden host (a hidden RPC node,
 *     a peer instance) crosses one whatever the page's own origin. (The
 *     orderbook comparison is same-origin: the indexer fetches the peer,
 *     /v1/compare/orderbook.)
 *
 * These budgets are CEILINGS, not delays. A healthy clearnet instance answers
 * in milliseconds and nothing waits longer than it used to.
 */

/**
 * True for a Tor, I2P or Lokinet hostname.
 *
 * `.loki` is included because the rest of the codebase already treats it as a
 * hidden network — `utils/instanceUrl.ts` accepts it, the instances page and
 * the footer render `alt_networks.lokinet`, and the indexer's federation probe
 * routes it over a hidden transport. Leaving it out here would have given a
 * Lokinet-served instance the clearnet budgets and therefore the original bug,
 * unchanged, while every other part of the app considered it hidden.
 */
export function isHiddenHostname(hostname: string | null | undefined): boolean {
	// Defensive about its input on purpose. This is called with whatever
	// `location.hostname` happens to be, and that is not a string in every
	// environment the app runs in — a harness that stubs `window` with only
	// `location.origin` yields undefined. An unguarded `.toLowerCase()` there
	// throws from inside a TIMEOUT CALCULATION, which is about the worst place
	// for an exception: the caller sees a failed request, retries, and fails
	// the same way forever. Everything a timeout helper touches has to be
	// total.
	if (typeof hostname !== 'string' || hostname.length === 0) return false;
	const h = hostname.toLowerCase();
	return h.endsWith('.onion') || h.endsWith('.i2p') || h.endsWith('.loki');
}

/** True when `originOrUrl` names a hidden host. Accepts a full origin, a bare
 *  hostname, `host:port`, or '' / a path (same-origin — not hidden by itself). */
export function isHiddenOrigin(originOrUrl: string | null | undefined): boolean {
	if (typeof originOrUrl !== 'string' || originOrUrl.length === 0) return false;
	// `//host` is protocol-relative: the part after the slashes IS a host, so it
	// must be handled before the path guard below, which would otherwise reject
	// it for starting with '/'.
	const protocolRelative = originOrUrl.startsWith('//');
	// A path is never a host. Checked before URL parsing because '/relay.i2p'
	// would otherwise reach the bare-hostname fallback and be misread.
	if (!protocolRelative && originOrUrl.startsWith('/')) return false;
	try {
		const parsed = new URL(originOrUrl);
		// `new URL('abc.onion:8080')` does NOT throw — WHATWG reads it as the
		// scheme `abc.onion:` with an EMPTY hostname, so a bare `host:port`
		// would silently classify as clearnet if we trusted this branch alone.
		if (parsed.hostname !== '') return isHiddenHostname(parsed.hostname);
	} catch {
		/* not a URL — fall through to the bare-host handling below */
	}
	// Bare hostname, `host:port`, or protocol-relative `//host`. Strip what is
	// not part of the host before testing the suffix.
	const bare = (/^(?:\/\/)?([^/?#]*)/.exec(originOrUrl)?.[1] ?? '').replace(/:\d+$/, '');
	return bare.length > 0 && isHiddenHostname(bare);
}

/** The page's own hostname, or null outside the browser (SSR, prerender). */
export function currentHostname(): string | null {
	// `window.location.hostname` is typed as a string but is not guaranteed to
	// be one at runtime — during prerender, inside a worker, or under a test
	// harness that stubs `window` with a partial `location`. Narrow it here so
	// no caller inherits an undefined it was told could not happen.
	if (typeof window === 'undefined') return null;
	const h = (window as Window & typeof globalThis).location?.hostname;
	return typeof h === 'string' && h.length > 0 ? h : null;
}

/** Does this request cross a hidden transport on either hop? */
export function crossesHiddenTransport(targetOrigin?: string | null): boolean {
	const here = currentHostname();
	if (here !== null && isHiddenHostname(here)) return true;
	return isHiddenOrigin(targetOrigin);
}

/** Indexer API budget — DB-backed endpoints, so the hidden figure is almost
 *  entirely circuit/tunnel setup rather than server work. */
export const INDEXER_TIMEOUT_CLEARNET_MS = 8_000;
export const INDEXER_TIMEOUT_HIDDEN_MS = 45_000;

/** Budget for one indexer API call, given the origin it is aimed at. */
export function indexerTimeoutMs(targetOrigin?: string | null): number {
	return crossesHiddenTransport(targetOrigin)
		? INDEXER_TIMEOUT_HIDDEN_MS
		: INDEXER_TIMEOUT_CLEARNET_MS;
}

/**
 * Raise ANY clearnet budget to the hidden-transport floor when the call
 * crosses one, and otherwise leave it exactly as the caller set it.
 *
 * The general form of the same rule `chainCallTimeoutMs` applies to
 * chain-backed endpoints. Use it for a request that is not an indexer API call
 * and not chain-backed, but still has to cross a circuit or a tunnel: a direct
 * browser→`.onion` RPC read, a static poll on a hidden origin, a relay call.
 *
 * NEVER shortens. A caller that already allows longer keeps its own number.
 */
export function withHiddenFloor(clearnetMs: number, target?: string | null): number {
	return crossesHiddenTransport(target)
		? Math.max(clearnetMs, INDEXER_TIMEOUT_HIDDEN_MS)
		: clearnetMs;
}

/** The indexer's own ceiling for ONE hidden-transport RPC read
 *  (`MORPHIT_HIDDEN_RPC_TIMEOUT_MS`, default 60_000, in apps/indexer). Mirrored
 *  here because every browser budget for a chain-backed endpoint has to clear
 *  it — a browser that gives up first turns the server still working into an
 *  error the user is shown. */
export const INDEXER_HIDDEN_RPC_TIMEOUT_MS = 60_000;

/** Browser ceiling for an endpoint that performs a real chain RPC server-side:
 *  the indexer's own 60s plus 15s for the browser↔instance hidden leg. */
export const CHAIN_VIA_INDEXER_HIDDEN_MS = INDEXER_HIDDEN_RPC_TIMEOUT_MS + 15_000;

/**
 * Raise a clearnet budget to the hidden floor when the call crosses a hidden
 * transport, and otherwise leave it exactly as the caller set it.
 *
 * Use this for EVERY same-origin endpoint that makes the indexer talk to the
 * chain — `/v1/chain/condenser`, `/v1/chain/properties`,
 * `/v1/chain/key-references`, `/v1/broadcast`. They look like local calls and
 * are not: each one can sit behind a 60-second hidden RPC. Sizing them like
 * local calls is what made a chat send fail on a Tor/I2P instance while the
 * identity check beside it succeeded.
 *
 * Mirrors `effectiveTimeoutMs` in @morphit/rpc-pool, which does the same thing
 * for the server's own outbound calls: never shorten, only raise a floor.
 */
export function chainCallTimeoutMs(clearnetMs: number, targetOrigin?: string | null): number {
	return crossesHiddenTransport(targetOrigin)
		? Math.max(clearnetMs, CHAIN_VIA_INDEXER_HIDDEN_MS)
		: clearnetMs;
}
