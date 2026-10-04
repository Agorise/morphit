/**
 * Morphit — release-asset hash verification.
 *
 * Given the hash manifest of the signed release (the files that start the
 * app: page shell, service worker, entry code), fetch each of those files
 * from THIS site and compare its SHA-256 with the signed one. It catches a
 * file changed by accident, by a partial compromise of the server, or by
 * something between the server and the browser.
 *
 *   • Each manifest key must be a plain same-origin path
 *     (`/` + [A-Za-z0-9._~/-], at most 200 characters; a key without the
 *     leading slash is read as one). Anything else — `//host/x`, a full
 *     URL, a backslash, a query — is refused WITHOUT a request, so a
 *     manifest can never make the page contact another host.
 *   • SHA-256 comes from SubtleCrypto, or from libsodium where the browser
 *     withholds SubtleCrypto (plain-HTTP I2P addresses).
 *
 * Cost: once per page load, a few small same-origin requests that the
 * browser or the service worker usually answers from cache.
 *
 * What it cannot do:
 *
 *   • Check files the manifest does not list.
 *   • Prove anything against the operator itself: the operator serves this
 *     code too, and a hostile one can serve a page that skips the check, or
 *     clean bytes to the check and other bytes to the page. There is no
 *     Subresource Integrity on the app's scripts. This is a detector for
 *     accidental or partial tampering, not a defence against the operator.
 *
 * Returns the list of mismatched assets so the UI can name names.
 */

import { fetchWithTimeout } from './fetchWithTimeout';

/** A manifest key the check will fetch: a plain path on this site. */
const MANIFEST_PATH_RE = /^\/(?!\/)[A-Za-z0-9._~/-]{1,200}$/;

export interface AssetMismatch {
	readonly path: string;
	readonly expected: string;
	readonly actual: string;
}

export type HashCheckResult =
	| { kind: 'ok' }
	| { kind: 'mismatch'; mismatches: readonly AssetMismatch[] }
	| { kind: 'fetch_failed'; path: string; cause: string }
	/** A manifest key that is not a plain same-origin path. Nothing was
	 *  fetched for it (or for any later key). */
	| { kind: 'refused'; path: string };

/** SHA-256 of a Uint8Array as a Subresource-Integrity-style
 *  `sha256-...=` base64 string. SubtleCrypto where the browser offers it;
 *  libsodium (loaded only then) where it does not — browsers withhold
 *  SubtleCrypto outside a secure context, e.g. on a plain-HTTP I2P
 *  address. */
async function sha256SriHash(bytes: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	let hash: Uint8Array;
	if (subtle) {
		hash = new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource));
	} else {
		const lib = await import('$crypto/sodium');
		await lib.ensureSodium();
		hash = lib.sodium.crypto_hash_sha256(bytes);
	}
	return `sha256-${uint8ArrayToBase64(hash)}`;
}

/** Standard (non-URL) base64. */
function uint8ArrayToBase64(arr: Uint8Array): string {
	let str = '';
	for (const b of arr) str += String.fromCharCode(b);
	return btoa(str);
}

/** The same-origin path a manifest key names, or null when the key is not
 *  a plain path on this site (then nothing may be fetched for it). A key
 *  without its leading slash is read as one. */
export function manifestKeyToSameOriginPath(key: string): string | null {
	const path = key.startsWith('/') ? key : `/${key}`;
	if (!MANIFEST_PATH_RE.test(path)) return null;
	const origin = globalThis.location?.origin;
	if (typeof origin !== 'string' || origin === '' || origin === 'null') return null;
	let url: URL;
	try {
		url = new URL(path, origin);
	} catch {
		return null;
	}
	if (url.origin !== origin) return null;
	return url.pathname;
}

/** Fetch one asset from this site and compute its SRI hash.
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
async function fetchAndHash(sameOriginPath: string): Promise<string> {
	const res = await fetchWithTimeout(sameOriginPath, {
		credentials: 'omit'
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} for ${sameOriginPath}`);
	}
	const buf = new Uint8Array(await res.arrayBuffer());
	return sha256SriHash(buf);
}

/** Check every entry in `manifest` against the asset this site serves at
 *  that path. Returns the mismatches, or `ok` if all hashes line up. Every
 *  key is validated BEFORE anything is fetched: one key that is not a plain
 *  same-origin path refuses the whole manifest (`refused`), with no request.
 *  A network failure aborts the check as `fetch_failed` — a partial match
 *  would silently miss tampering on an unreachable asset. */
export async function checkManifestAgainstRunningBundle(
	manifest: Readonly<Record<string, string>>
): Promise<HashCheckResult> {
	const entries: { path: string; target: string; expected: string }[] = [];
	for (const [path, expected] of Object.entries(manifest)) {
		const target = manifestKeyToSameOriginPath(path);
		if (target === null) return { kind: 'refused', path };
		entries.push({ path, target, expected });
	}
	const mismatches: AssetMismatch[] = [];
	for (const { path, target, expected } of entries) {
		let actual: string;
		try {
			actual = await fetchAndHash(target);
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
