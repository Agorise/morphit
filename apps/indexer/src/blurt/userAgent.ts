/**
 * Morphit indexer — identify ourselves to RPC nodes.
 *
 * v1.7.7, t.txt #3. Ken's sysadmin, who runs a public Blurt RPC node:
 *
 *   "Are you using the User Agent: node-fetch/1.0 ? ... please change our user
 *    agent to something like: Morphit/1.7.5 (+contact...) ... to avoid the Bot
 *    Trap."
 *
 * ACCURATE ANSWER, because a bot-trap rule written against the wrong string
 * matches nothing: we do NOT send `node-fetch/1.0`. We send **`user-agent:
 * node`** — verified against Node 22, not assumed. `@beblurt/dblurt` calls the
 * global `fetch` and sets no User-Agent of its own, and Node's built-in fetch
 * (undici) defaults to the bare string `node`. Every anonymous Node service on
 * the internet sends exactly that, which is precisely why it trips bot traps:
 * it identifies a runtime, not an application, and gives an operator nothing to
 * contact when our traffic misbehaves.
 *
 * WHY A GLOBAL WRAPPER, WHICH IS OTHERWISE A THING TO AVOID.
 * There are two RPC transports here and only one of them is ours:
 *   1. `blurt/client.ts`'s direct `fetch` for batched `get_block` — ours, easy.
 *   2. `@beblurt/dblurt`'s `Client` — used for everything else. Its
 *      `ClientOptions` exposes `chainId`, `timeout`, `failoverThreshold`,
 *      `backoff`, `agent` — and no way to set a header. Checked the bundle: it
 *      calls global `fetch` directly.
 *
 * So a wrapper installed once at startup is the only thing that can reach BOTH,
 * and patching per-call-site would leave dblurt — the majority of our traffic —
 * still anonymous, which is the whole complaint.
 *
 * Deliberately narrow:
 *   - it only ever ADDS a header, never removes or rewrites one;
 *   - an explicit User-Agent from a caller always wins (the federation and
 *     signup-anomaly probes already name themselves, and should keep doing so);
 *   - it is idempotent, so a double-install in tests or a reload is harmless;
 *   - server-side only. It is never imported by the web app, where changing the
 *     browser's User-Agent would be both impossible and a fingerprinting risk.
 */

/** Contact point published with our traffic. Deliberately the project's public
 *  source home rather than a personal address: an RPC operator who wants us to
 *  back off needs somewhere durable to shout, and Morphit is federated — the
 *  node operator and the instance operator are usually not the same person. */
const CONTACT_URL = 'https://git.agorise.net/agorise/morphit';

let installed = false;

/** Build the User-Agent line. Exported for the smoke, which asserts the shape
 *  rather than trusting a comment. */
export function morphitUserAgent(version: string): string {
	return `Morphit/${version} (+${CONTACT_URL})`;
}

/**
 * Wrap the global `fetch` so every outbound request identifies Morphit.
 *
 * Call once, early in startup, before any RPC client is constructed.
 */
export function installMorphitUserAgent(version: string): void {
	if (installed) return;
	installed = true;

	const ua = morphitUserAgent(version);
	const original = globalThis.fetch;

	globalThis.fetch = function morphitFetch(
		input: Parameters<typeof original>[0],
		init?: Parameters<typeof original>[1]
	): ReturnType<typeof original> {
		const headers = new Headers(init?.headers ?? {});
		// A caller that named itself keeps its name. The probes rely on this —
		// `morphit-indexer/federation-probe` is more useful to a node operator
		// reading logs than a generic Morphit line would be.
		if (!headers.has('user-agent')) headers.set('user-agent', ua);

		// `input` may be a Request carrying its own headers. Passing our Headers
		// via init would silently drop them, so merge instead of overwrite.
		if (input instanceof Request && init?.headers === undefined) {
			const merged = new Headers(input.headers);
			if (!merged.has('user-agent')) merged.set('user-agent', ua);
			return original(new Request(input, { headers: merged }), init);
		}

		return original(input, { ...init, headers });
	} as typeof original;
}

/** Test-only: undo the wrapper so a suite can install it again. */
export function __resetUserAgentInstall(): void {
	installed = false;
}
