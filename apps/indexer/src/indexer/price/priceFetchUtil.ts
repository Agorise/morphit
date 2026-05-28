/**
 * Hardened fetch helper for price-feed upstreams (cp159
 * F-indexer-1/2/3).
 *
 * The price fetchers (coingeckoFetcher.ts, klingexFetcher.ts)
 * fetch from operator-configured upstream HTTP APIs (Coingecko,
 * Klingex).  The URL is trusted (operator picks it; defaults to
 * the known-good public API endpoint), so SSRF defense isn't
 * the threat model here — the @morphit/net-defense fetchJson
 * stack covers the federation case where URLs come from
 * untrusted operator-register payloads.
 *
 * What IS relevant for price feeds:
 *
 *   1. **Body size cap** — a misbehaving (or compromised)
 *      upstream returning a multi-GB JSON would exhaust the
 *      indexer's memory.  Price payloads are normally <500 bytes
 *      ("{\"blurt\":{\"usd\":0.00237}}" is 28 bytes); a 64 KiB
 *      cap is 100x normal and still catches any pathology.
 *
 *   2. **redirect: 'manual'** — a 30x response chain to an
 *      unexpected URL shouldn't be followed silently.  If
 *      Coingecko ever redirects to a different host, the
 *      operator should see an explicit failure and choose to
 *      update their config rather than the indexer silently
 *      pulling prices from a redirected origin.
 *
 *   3. **User-Agent** — Node's default UA leaks Node version
 *      and identifies the fetcher as a generic script.  A named
 *      UA ("morphit-indexer/price-fetch") is friendlier for
 *      Coingecko's rate-limiter to identify and contact us if
 *      needed.
 *
 * The shape mirrors `apps/mcp-server/src/indexerClient.ts`
 * `readBodyCapped` (cp151 F-mcp-5) and federationProbe's
 * `fetchJson` (cp154 net-defense lift): pre-check
 * Content-Length, stream the response, abort on cap-exceed.
 */

import { logger } from '$log';

const log = logger('price-fetch-util');

/** Cap response body at 64 KiB.  Price-feed responses are
 *  normally <500 bytes; 64 KiB is 100x normal and still catches
 *  any upstream pathology (multi-MB error pages, infinite-loop
 *  responses).  Configurable via env for operators who need to
 *  raise the bound for an upstream with verbose response wrapping. */
export const PRICE_FETCH_MAX_BODY_BYTES = (() => {
	const raw = process.env.MORPHIT_INDEXER_PRICE_FETCH_MAX_BODY_BYTES;
	if (raw === undefined) return 64 * 1024;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 16 * 1024 * 1024) {
		log.warn('invalid_price_fetch_max_body_bytes', {
			raw,
			fallback: 64 * 1024
		});
		return 64 * 1024;
	}
	return parsed;
})();

/** Named user-agent for outbound price-feed requests.  Fixed
 *  string (not version-derived) — upstream APIs don't care about
 *  Morphit version, just that the UA isn't the default leaky one. */
export const PRICE_FETCH_USER_AGENT = 'morphit-indexer/price-fetch';

/**
 * Read a Response body while enforcing PRICE_FETCH_MAX_BODY_BYTES.
 *
 * Two-layer defense:
 *   1. Content-Length header pre-check (rejects before any body
 *      read).
 *   2. Streaming reader with `ac.abort()` (catches the case where
 *      Content-Length is absent or lies).
 *
 * Returns the body as a UTF-8 string.  Caller does JSON.parse.
 *
 * Throws on cap exceed; caller handles via the price-feeder's
 * outer try/catch which returns null and triggers fallback to
 * the next upstream in the composite chain.
 */
export async function readPriceBodyCapped(
	res: Response,
	ac: AbortController,
	url: string
): Promise<string> {
	// Layer 1: Content-Length pre-check.
	const cl = res.headers.get('content-length');
	if (cl !== null) {
		const n = Number(cl);
		if (Number.isFinite(n) && n > PRICE_FETCH_MAX_BODY_BYTES) {
			ac.abort();
			throw new Error(
				`price-fetch body exceeds cap (Content-Length ${n} > ${PRICE_FETCH_MAX_BODY_BYTES}): ${url}`
			);
		}
	}

	// Layer 2: streaming read with abort on cap-exceed.
	const reader = res.body?.getReader();
	if (!reader) {
		// No body stream — should be rare for HTTP responses but
		// possible (e.g. test mocks).  Fall back to text() with
		// post-hoc length check.
		const text = await res.text();
		if (text.length > PRICE_FETCH_MAX_BODY_BYTES) {
			throw new Error(
				`price-fetch body exceeds cap (post-text ${text.length} > ${PRICE_FETCH_MAX_BODY_BYTES}): ${url}`
			);
		}
		return text;
	}

	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let total = 0;

	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		total += r.value.byteLength;
		if (total > PRICE_FETCH_MAX_BODY_BYTES) {
			ac.abort();
			try {
				reader.releaseLock();
			} catch {
				// best-effort cleanup; the abort already does the work
			}
			throw new Error(
				`price-fetch body exceeds cap (stream ${total} > ${PRICE_FETCH_MAX_BODY_BYTES}): ${url}`
			);
		}
		// stream: true keeps any trailing multi-byte char buffered
		// for the next chunk so we don't decode an invalid sequence.
		chunks.push(decoder.decode(r.value, { stream: true }));
	}
	// Flush any final buffered multi-byte sequence.
	chunks.push(decoder.decode());
	return chunks.join('');
}

/**
 * Standard outbound headers for price-feed upstream calls.
 * Callers spread this into their own headers object so they can
 * add provider-specific extras (e.g. coingecko's
 * `x-cg-pro-api-key`).
 */
export function priceUpstreamHeaders(): Record<string, string> {
	return {
		accept: 'application/json',
		'user-agent': PRICE_FETCH_USER_AGENT
	};
}

/**
 * Standard `fetch()` options for price-feed upstream calls.
 *
 * Caller passes in their AbortController signal (the
 * per-fetcher timeout controller).  This helper layers in:
 *   - `redirect: 'manual'` — no 30x chains to unexpected hosts
 *   - method GET (price-feed reads only)
 *
 * Returns a partial RequestInit for spreading; callers add
 * headers and any provider-specific fields.
 */
export function priceUpstreamFetchInit(signal: AbortSignal): Pick<RequestInit, 'method' | 'redirect' | 'signal'> {
	return {
		method: 'GET',
		redirect: 'manual',
		signal
	};
}
