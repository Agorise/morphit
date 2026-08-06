/**
 * Morphit indexer — the User-Agent line we send to RPC nodes.
 *
 * Ken's sysadmin, who runs a public Blurt RPC node, asked us to stop looking
 * like an anonymous bot. Node's built-in fetch (undici) defaults to the bare
 * string `node` — every unnamed Node service on the internet sends exactly
 * that, which is why it trips bot-traps: it names a runtime, not an
 * application, and gives an operator nobody to contact when our traffic
 * misbehaves. So we name ourselves and carry a durable contact URL.
 *
 * Every outbound path sets this explicitly now:
 *   - `@beblurt/dblurt`'s Client via its native `userAgent` option (0.17.0),
 *   - the direct batch fetch (`blurt/client.ts`) + the rpcHealth probe via an
 *     explicit `user-agent` header,
 *   - the price/fx feeds via `priceUpstreamHeaders()`,
 *   - the federation + signup-anomaly probes, which name themselves more
 *     specifically.
 *
 * The global-fetch wrapper this module used to install (`installMorphitUserAgent`)
 * was retired once dblurt gained a native UA option and every call site named
 * itself; `rpc-user-agent-smoke` now guards that no raw fetch is left anonymous,
 * replacing the wrapper's runtime catch-all with a CI-time check.
 *
 * Server-side only — never imported by the web app, where changing the
 * browser's User-Agent is impossible and a fingerprinting risk.
 */

/** Contact point published with our traffic. Deliberately the project's public
 *  source home rather than a personal address: an RPC operator who wants us to
 *  back off needs somewhere durable to shout, and Morphit is federated — the
 *  node operator and the instance operator are usually not the same person. */
const CONTACT_URL = 'https://git.agorise.net/agorise/morphit';

/** Build the User-Agent line. Exported for the smoke, which asserts the shape
 *  rather than trusting a comment. */
export function morphitUserAgent(version: string): string {
	return `Morphit/${version} (+${CONTACT_URL})`;
}
