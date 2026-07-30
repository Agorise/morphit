/**
 * Morphit — release-asset hash verification (Batch J).
 *
 * Given a validated release manifest and the running build's
 * known-loaded assets, detect tampering: a serving CDN that mutated
 * a JS bundle in flight, a hijacked DNS, or a malicious mirror
 * substituting our index.html.
 *
 * Strategy:
 *
 *   • At app boot, after fetching the verified release, fetch each
 *     asset listed in the manifest from the running origin.
 *   • Compute SHA-256 over the asset bytes via SubtleCrypto.
 *   • Encode as base64, prefix with `sha256-`, compare to manifest
 *     entry.  Any mismatch → tampered build.
 *
 * Performance: this happens once per session.  Each asset is
 * already in the browser cache (the running bundle was just
 * served), so the fetch hits the cache, not the network.  The
 * SubtleCrypto hash is fast (a few ms per asset).  Total cost:
 * single-digit milliseconds for a typical manifest.
 *
 * What we DON'T check:
 *
 *   • Assets not in the manifest.  The signer chooses what to list;
 *     if they list only index.html, we only check that.
 *   • The currently-running scripts.  We can't introspect "what
 *     code is currently executing in this tab" — we re-fetch and
 *     hash.  The browser cache gives us a high-confidence answer
 *     about what was served, but a sufficiently-clever attacker
 *     who controls the CDN can serve a clean copy on the verify
 *     fetch and a tampered copy on the original.  This is a known
 *     limitation of any client-side post-load verification.  The
 *     real defense against that attacker is Subresource Integrity
 *     attributes, set on the original <script> tags by the
 *     deploy-time build pipeline using these same hashes — that
 *     prevents the browser from running tampered scripts in the
 *     first place.  This module is the post-hoc detection layer
 *     that catches DEPLOY-time mismatches (someone pushed an
 *     unsigned build) and provides a UI surface for them.
 *
 * Returns the list of mismatched assets so the UI can name names.
 */

import { fetchWithTimeout } from './fetchWithTimeout';

export interface AssetMismatch {
	readonly path: string;
	readonly expected: string;
	readonly actual: string;
}

export type HashCheckResult =
	| { kind: 'ok' }
	| { kind: 'mismatch'; mismatches: readonly AssetMismatch[] }
	| { kind: 'fetch_failed'; path: string; cause: string };

/** Compute SHA-256 of a Uint8Array, return as Subresource-
 *  Integrity-style `sha256-...=` base64 string.
 *
 *  Uses SubtleCrypto (available in all modern browsers and in Node
 *  18+ as `globalThis.crypto.subtle`).  This module assumes a
 *  browser context — if SubtleCrypto isn't available, callers get
 *  a clear runtime error rather than a confusing failure mode. */
async function sha256SriHash(bytes: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new Error('SubtleCrypto unavailable — cannot hash assets');
	}
	const hash = await subtle.digest('SHA-256', bytes as BufferSource);
	const b64 = uint8ArrayToBase64(new Uint8Array(hash));
	return `sha256-${b64}`;
}

/** Convert a Uint8Array to standard (non-URL) base64.  Avoids the
 *  dependency on $crypto/keystore's libsodium for this single use
 *  — a hand-rolled base64 is simpler than transitively pulling in
 *  the heavy lib for a hash check. */
function uint8ArrayToBase64(arr: Uint8Array): string {
	let str = '';
	for (const b of arr) str += String.fromCharCode(b);
	return btoa(str);
}

/** Fetch one asset from `${origin}${path}` (origin is the running
 *  page's origin) and compute its SRI hash.  Path should start
 *  with `/`; we don't add one (avoids accidental `//` in URLs).
 *
 *  We deliberately DO NOT pass `cache: 'no-store'` here.  Threat
 *  model:
 *
 *    - If a tampering attacker uniformly serves bad bytes, it
 *      doesn't matter whether the verify fetch hits cache or
 *      network — the hash mismatches, detected.
 *    - If a sophisticated attacker serves tampered bytes on the
 *      INITIAL load but clean bytes on subsequent fetches (e.g.
 *      filtering by Sec-Fetch-Dest, or by a forensic-bypass
 *      header), then `cache: 'no-store'` REDUCES our detection:
 *      we'd hit the network and receive the clean copy, missing
 *      the tamper.  Letting the verify fetch satisfy from the
 *      browser cache means we hash the bytes the browser
 *      actually loaded — i.e. what's currently RUNNING.  That's
 *      the correct semantic.
 *
 *  An attacker who controls the cache layer specifically (not
 *  just the origin) is outside our threat model — we can't
 *  protect against the user's own browser being compromised. */
async function fetchAndHash(path: string): Promise<string> {
	// Same-origin fetch only.  We don't allow the manifest to point
	// at cross-origin assets — that would make hash verification
	// vulnerable to a CORS-disabled mirror serving substituted
	// content while the verify probe still hashes our copy.  Strip
	// any leading scheme/origin from the path.
	const safePath = path.startsWith('/') ? path : `/${path}`;
	const res = await fetchWithTimeout(safePath, {
		credentials: 'omit'
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} for ${safePath}`);
	}
	const buf = new Uint8Array(await res.arrayBuffer());
	return sha256SriHash(buf);
}

/** Check every entry in `manifest` against the actually-served
 *  asset at the same path.  Returns first the mismatches, or `ok`
 *  if all hashes line up.  Network failures abort the whole check
 *  and surface as `fetch_failed` — we don't want to PARTIAL-match
 *  and silently miss tamper on an unreachable asset. */
export async function checkManifestAgainstRunningBundle(
	manifest: Readonly<Record<string, string>>
): Promise<HashCheckResult> {
	const mismatches: AssetMismatch[] = [];
	for (const [path, expected] of Object.entries(manifest)) {
		let actual: string;
		try {
			actual = await fetchAndHash(path);
		} catch (err) {
			return {
				kind: 'fetch_failed',
				path,
				cause: err instanceof Error ? err.message : String(err)
			};
		}
		if (actual !== expected) {
			mismatches.push({ path, expected, actual });
		}
	}
	if (mismatches.length === 0) {
		return { kind: 'ok' };
	}
	return { kind: 'mismatch', mismatches };
}
