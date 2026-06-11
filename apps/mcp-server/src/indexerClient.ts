/**
 * Thin HTTP client for the Morphit indexer's public /v1/ API.
 *
 * Every Morphit instance exposes the same v1 surface (orderbook,
 * orders, profiles, operators, instances, etc.).  This client
 * targets whatever instance the operator (or end user) configures
 * via MORPHIT_MCP_INSTANCE_URL — defaulting to https://morphit.io.
 *
 * Read-only.  Never sends authenticated requests.  Never holds
 * keys.  The instance sees the MCP server's IP, which is the end
 * user's IP unless they're behind Tor — same privacy posture as
 * visiting the Morphit web UI in a browser.
 */

import { isPrivateHostname } from '@morphit/net-defense';

const DEFAULT_INSTANCE_URL = 'https://morphit.io';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Maximum response body size in bytes.  cp151 finding F-mcp-5.
 *
 * Threat model: a malicious instance operator can return an
 * arbitrarily large response body (multi-GB JSON, infinite
 * chunked stream).  Without a cap, `await res.text()` or
 * `await res.json()` accumulates everything into memory before
 * parsing, exhausting Charlie's heap and crashing the MCP
 * server (which the user then has to restart, and which the
 * AI agent now reads as a transient tool failure to retry —
 * a single malicious instance could amplify into resource
 * exhaustion across the agent).
 *
 * Cap is generous: 4 MiB.  A typical orderbook /v1/orders
 * response is a few hundred rows × ~500 bytes = ~150 KB.  The
 * largest legitimate v1 response observed is ~500 KB on busy
 * instances.  4 MiB gives 8× headroom over the high-water mark
 * while bounding the attack surface to a value any modern
 * device can comfortably hold.
 *
 * Operator override: `MORPHIT_MCP_MAX_BODY_BYTES` env var, in
 * bytes.  Use cases for raising the cap include private
 * deployments where /v1/ endpoints have been extended with
 * larger response surfaces; lowering it is safe at any time.
 * Values <= 0 are treated as "use default."
 */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

function maxBodyBytes(): number {
	const raw = process.env.MORPHIT_MCP_MAX_BODY_BYTES;
	if (!raw) return DEFAULT_MAX_BODY_BYTES;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BODY_BYTES;
	return n;
}

/**
 * Server identification string for the User-Agent header.  Read
 * the version from the bundled package.json so it never drifts
 * when the package version bumps.  See cp146 finding F-mcp-4.
 *
 * createRequire is the canonical ESM-safe way to load JSON in
 * Node 22+; the alternative (`with { type: 'json' }` import
 * attributes) works but produces type-checker noise without
 * resolveJsonModule reorganization.
 */
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const PKG = _require('../package.json') as { version: string };
const USER_AGENT = `morphit-mcp/${PKG.version} (+https://morphit.io)`;

/**
 * Strip userinfo (user / password) from a URL for safe inclusion
 * in error messages and logs.  `new URL().toString()` preserves
 * userinfo; we clear it before stringifying.  cp146 finding
 * F-mcp-2: if MORPHIT_MCP_INSTANCE_URL is set to
 * `https://user:pass@morphit.io/`, the original `fetchJson` error
 * paths echoed the full URL (including creds) back to the AI
 * agent — which then propagates to chat transcripts.
 *
 * Returns the URL string unchanged if it doesn't parse; callers
 * already validate via `getInstanceUrl()` so this is belt-and-
 * braces, not the validation gate.
 */
function redactUserinfo(url: string): string {
	try {
		const u = new URL(url);
		if (u.username || u.password) {
			u.username = '';
			u.password = '';
			return u.toString();
		}
		return url;
	} catch {
		return url;
	}
}

/**
 * Resolve the target instance URL from env var, with a fallback
 * and a sanity check.  Strip trailing slash for clean joins.
 *
 * cp154 F-mcp-1 — defense-in-depth against private-address
 * instance URLs.  By default reject hostnames in the private
 * ranges (localhost, 127.0.0.1, 10/8, 192.168/16, link-local
 * cloud-metadata addresses, .local/.internal TLDs).  Opt-in via
 * `MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE=1` for legitimate cases
 * (self-hosted instance on the same machine for dev, Tor onion
 * that resolves to a private-looking address, lab setups).
 *
 * Trust model rationale: MORPHIT_MCP_INSTANCE_URL is
 * user-supplied via the MCP client config, so the "attacker
 * controls the URL" threat is mostly "user attacked themselves
 * via misconfig OR their MCP client config was compromised."
 * The latter is a worse problem than SSRF in general, but the
 * private-address denylist is cheap defense-in-depth — it
 * catches obvious mistakes (paste of a localhost URL into
 * the wrong field) and modestly raises the bar for chained
 * exploits.
 */
export function getInstanceUrl(): string {
	const raw =
		process.env.MORPHIT_MCP_INSTANCE_URL?.trim() || DEFAULT_INSTANCE_URL;
	// Reject blatantly malformed URLs early; the MCP client may pass
	// arbitrary strings if the user fat-fingers the config.
	let u: URL;
	try {
		u = new URL(raw);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`MORPHIT_MCP_INSTANCE_URL is not a valid URL (${msg}): ${raw}`
		);
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') {
		throw new Error(
			`MORPHIT_MCP_INSTANCE_URL has unsupported scheme (${u.protocol}): ${raw}`
		);
	}
	// cp154 F-mcp-1 — private-address denylist.  See docblock above.
	if (isPrivateHostname(u.hostname)) {
		const allow = process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE === '1';
		if (!allow) {
			throw new Error(
				`MORPHIT_MCP_INSTANCE_URL resolves to a private-address hostname (${u.hostname}): ${raw}.  If this is intentional (self-hosted instance, Tor onion that resolves locally, dev setup), set MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE=1 to opt in.`
			);
		}
	}
	return raw.replace(/\/+$/, '');
}

/** Build a v1 URL with proper query-string encoding. */
export function buildV1Url(
	path: string,
	params?: Record<string, string | number | undefined>
): string {
	const base = getInstanceUrl();
	const cleaned = path.startsWith('/') ? path : `/${path}`;
	const url = new URL(`${base}/v1${cleaned}`);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v === undefined || v === null || v === '') continue;
			url.searchParams.set(k, String(v));
		}
	}
	return url.toString();
}

/** Standardized fetch with timeout.  Returns the parsed JSON or
 *  throws an Error with a useful diagnostic. */
export async function fetchJson<T = unknown>(
	url: string,
	opts: { timeoutMs?: number } = {}
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ac.signal,
			// cp146 F-mcp-3 — `redirect: 'manual'` so a malicious
			// or misconfigured instance can't redirect the client
			// to an unintended URL (internal address, third-party
			// origin) and have us fetch it.  We treat any redirect
			// as a hard error; callers expect Morphit's /v1/ surface
			// to respond 2xx directly.  Mirrors the indexer's
			// federationProbe SSRF defense posture (cp139-F-2).
			redirect: 'manual',
			headers: {
				// User-Agent identifies the MCP server to instance
				// operators looking at their access logs.  Some
				// agentic-AI traffic identifies itself similarly so
				// operators can rate-limit/observe AI patterns
				// separately if they want.
				'User-Agent': USER_AGENT,
				Accept: 'application/json'
			}
		});
		// `redirect: 'manual'` surfaces as `res.type === 'opaqueredirect'`
		// with `res.status === 0`.  Convert to a clean error before
		// the !res.ok branch (which would otherwise emit a confusing
		// "HTTP 0  from ..." message).
		if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
			throw new Error(
				`unexpected redirect from ${redactUserinfo(url)} — Morphit /v1/ endpoints should respond directly`
			);
		}

		// cp151 F-mcp-5 — Content-Length pre-check.  If the
		// server declares a body larger than the cap, reject
		// BEFORE allocating a single byte.  This handles the
		// honest-server case where the response was unexpectedly
		// large (different API version, debug endpoint, etc.)
		// without consuming any memory.  Malicious servers can
		// of course lie about Content-Length or omit it; the
		// streaming check below handles those cases.
		const cap = maxBodyBytes();
		const declared = res.headers.get('content-length');
		if (declared !== null) {
			const declaredN = Number.parseInt(declared, 10);
			if (Number.isFinite(declaredN) && declaredN > cap) {
				throw new Error(
					`response from ${redactUserinfo(url)} declares ${declaredN} bytes (cap is ${cap}); refusing to fetch`
				);
			}
		}

		// cp151 F-mcp-5 — Streaming body read with cap
		// enforcement.  Read chunks via the response's body
		// reader, accumulate bytes into an array, and abort the
		// fetch if total exceeds the cap.  This handles chunked
		// responses, dishonest Content-Length, and infinite
		// streams.  The fetch's AbortController is the canonical
		// way to release the network resource without waiting
		// for the server to close.
		const body = await readBodyCapped(res, cap, ac, url);

		if (!res.ok) {
			const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
			throw new Error(
				`HTTP ${res.status} ${res.statusText} from ${redactUserinfo(url)}: ${text.slice(0, 200)}`
			);
		}
		try {
			return JSON.parse(new TextDecoder('utf-8').decode(body)) as T;
		} catch (parseErr) {
			const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
			throw new Error(
				`response from ${redactUserinfo(url)} is not valid JSON: ${msg}`
			);
		}
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error(
				`request to ${redactUserinfo(url)} timed out after ${timeoutMs}ms`
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Read a response body with a hard byte-count cap.  cp151 F-mcp-5.
 *
 * Uses the streaming reader to pull chunks one at a time.  When
 * the running total exceeds the cap, abort the fetch (releasing
 * the network connection) and throw with the cap in the message.
 *
 * For honest responses under the cap, returns the assembled
 * bytes as a Uint8Array.  Caller is responsible for parsing
 * (TextDecoder + JSON.parse, or whatever the content type
 * implies).
 *
 * If `res.body` is null (e.g. HEAD response, 204 No Content),
 * returns an empty Uint8Array.  The HTTP-status branches in
 * the caller decide how to interpret that.
 */
async function readBodyCapped(
	res: Response,
	cap: number,
	ac: AbortController,
	url: string
): Promise<Uint8Array> {
	if (!res.body) return new Uint8Array(0);

	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > cap) {
				// Abort the fetch to release the network resource.
				// The fetchJson outer try/catch will see this as
				// AbortError; we re-throw with the cap-violation
				// message so the caller knows it's defensive, not
				// transient.
				try {
					ac.abort();
				} catch {
					// Best-effort abort; the throw below is the
					// authoritative signal.
				}
				try {
					reader.releaseLock();
				} catch {
					// Same — best-effort cleanup.
				}
				throw new Error(
					`response from ${redactUserinfo(url)} exceeded body cap (${cap} bytes); refusing to fetch`
				);
			}
			chunks.push(value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader may already be released; ignore.
		}
	}

	// Concatenate chunks.  For typical responses (< 1MB, few
	// chunks) this is cheap; for very large responses near the
	// cap, this is the unavoidable one-time allocation.
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/** The public-facing order fields an AI agent (and the user it serves)
 *  actually need. This is the deliberate boundary between what the
 *  indexer's owner-view endpoints can return and what we surface to an
 *  agent — internal fields (fee_status, fee_method, internal ids, raw
 *  block data, anything added later) are dropped by being absent here,
 *  so the allowlist is forward-safe. */
const ORDERBOOK_PUBLIC_FIELDS: ReadonlySet<string> = new Set([
	'account',
	'permlink',
	'asset',
	'side',
	'fiat_currency',
	'price',
	'amount_min',
	'amount_max',
	'location_region',
	'payment_methods',
	'terms',
	'feedback_count',
	'weighted_rating',
	'is_new_trader',
	'updated_at',
	'created_at'
]);

/** Strip a known set of indexer-internal fields that aren't useful
 *  to an AI agent (and would just bloat the context window).  Keep
 *  the public-facing fields the agent and user actually need. */
export function trimOrderRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		if (ORDERBOOK_PUBLIC_FIELDS.has(k)) out[k] = v;
	}
	return out;
}

/** Like {@link trimOrderRow} but for the single-listing lookup, which
 *  hits the owner-view `/v1/orders/:account` endpoint. That endpoint
 *  returns every order regardless of status PLUS the lister's internal
 *  fee mechanics (`fee_status`, `fee_method`) — which the public
 *  orderbook never exposes and an agent has no use for (knowing a
 *  lister paid their listing fee in XMR vs Blurt, or that it was their
 *  waived first buy, is a needless pattern leak). We keep `status` and
 *  `expires_at` (genuinely useful for a specific-listing view — the
 *  agent can tell the user a listing is cancelled/expired or when it
 *  lapses) and drop the rest via the same allowlist. */
export function trimListingRow(row: Record<string, unknown>): Record<string, unknown> {
	const keep = new Set<string>([...ORDERBOOK_PUBLIC_FIELDS, 'status', 'expires_at']);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		if (keep.has(k)) out[k] = v;
	}
	return out;
}
