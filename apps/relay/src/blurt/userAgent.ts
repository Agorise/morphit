/**
 * Morphit relay — identify ourselves to RPC nodes.
 *
 * The relay talks to Blurt RPC nodes only through `@beblurt/dblurt`'s `Client`
 * (see `blurt/client.ts`). dblurt 0.17.0 exposes a native `userAgent`
 * ClientOption, so — unlike the indexer, which historically needed a global
 * fetch wrapper to reach dblurt — the relay identifies itself purely through
 * that option. No monkey-patch here.
 *
 * Node's built-in fetch (undici) otherwise defaults to the bare string `node`,
 * which every anonymous Node service on the internet sends and which trips RPC
 * bot-traps: it names a runtime, not an application, and gives an operator
 * nobody to contact when our traffic misbehaves.
 *
 * Same shape and contact point as the indexer's `blurt/userAgent.ts`, so an RPC
 * operator's allowlist that matches `Morphit/` catches both.
 */

/** Contact point published with our traffic — the project's public source home
 *  (durable, and Morphit is federated: node operator ≠ instance operator). */
const CONTACT_URL = 'https://git.agorise.net/agorise/morphit';

/** Build the relay's User-Agent line. Exported for the smoke, which asserts the
 *  shape rather than trusting a comment. */
export function morphitUserAgent(version: string): string {
	return `Morphit/${version} (+${CONTACT_URL})`;
}
