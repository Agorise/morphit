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

const DEFAULT_INSTANCE_URL = 'https://morphit.io';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolve the target instance URL from env var, with a fallback
 * and a sanity check.  Strip trailing slash for clean joins.
 */
export function getInstanceUrl(): string {
	const raw =
		process.env.MORPHIT_MCP_INSTANCE_URL?.trim() || DEFAULT_INSTANCE_URL;
	// Reject blatantly malformed URLs early; the MCP client may pass
	// arbitrary strings if the user fat-fingers the config.
	try {
		const u = new URL(raw);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') {
			throw new Error(`unsupported scheme: ${u.protocol}`);
		}
		return raw.replace(/\/+$/, '');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`MORPHIT_MCP_INSTANCE_URL is not a valid URL (${msg}): ${raw}`
		);
	}
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
			headers: {
				// User-Agent identifies the MCP server to instance
				// operators looking at their access logs.  Some
				// agentic-AI traffic identifies itself similarly so
				// operators can rate-limit/observe AI patterns
				// separately if they want.
				'User-Agent': 'morphit-mcp/1.0.0-beta.1 (+https://morphit.io)',
				Accept: 'application/json'
			}
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '<no body>');
			throw new Error(
				`HTTP ${res.status} ${res.statusText} from ${url}: ${body.slice(0, 200)}`
			);
		}
		return (await res.json()) as T;
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/** Strip a known set of indexer-internal fields that aren't useful
 *  to an AI agent (and would just bloat the context window).  Keep
 *  the public-facing fields the agent and user actually need. */
export function trimOrderRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const keep = new Set([
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
	for (const [k, v] of Object.entries(row)) {
		if (keep.has(k)) out[k] = v;
	}
	return out;
}
