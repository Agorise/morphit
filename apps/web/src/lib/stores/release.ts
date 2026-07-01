/**
 * Morphit — release-trust-anchor store (Batch J).
 *
 * Single source of truth for "what's the latest officially-released
 * version, are we running it, and is the bundle we're running
 * actually the announced bundle?"
 *
 * Surfaces three reactive flags:
 *
 *   • `release` — the verified release info (or null).
 *   • `staleBuild` — running version differs from announced.
 *   • `tamperedAssets` — non-empty list of assets whose served
 *      bytes don't match the signed manifest.
 *
 * Boot flow:
 *
 *   1. `initRelease()` is called once from `+layout.svelte`'s
 *      onMount.  Subsequent calls are no-ops (the inflight or
 *      completed result is cached in the store).
 *   2. Fetches a verified release via `fetchVerifiedRelease()` —
 *      chain-direct fetch + trust-anchor pubkey check + payload
 *      validation.
 *   3. If verified, runs the hash-manifest check against the
 *      currently-served assets.  Asynchronous: the staleBuild
 *      banner can render before the tampered-build check
 *      completes.
 *
 * Failure modes don't trigger user-visible alarms unless we have
 * positive evidence:
 *
 *   - Chain RPC unreachable → silent.  We can't tell what the
 *     announced version is.  Showing a "your build might be
 *     stale!" banner with no evidence would be more annoying than
 *     informative.
 *   - Pubkey mismatch → CRITICAL alert.  Either the trust anchor
 *     was rotated (legit but our pin is stale) or someone is
 *     trying to forge the release op.  Either way, the release
 *     can't be trusted; the banner says exactly that.
 *   - Asset hash mismatch → CRITICAL alert.  CDN tampering or
 *     deploy-time mismatch.  The banner names the affected files.
 *
 * No periodic refresh in the store itself.  Releases are
 * infrequent; one fetch per session is sufficient.  Long-lived
 * sessions (a tab left open for days) will see the latest at the
 * next page reload.
 */

import { writable, derived, type Readable } from 'svelte/store';
// fetchVerifiedRelease + checkManifestAgainstRunningBundle are dynamically
// imported inside initRelease() (cp271 byte budget): both statically pull
// $blurt/client, and initRelease runs in the layout's onMount — NOT at first
// paint — so deferring them keeps the Blurt client out of every page's
// baseline modulepreload closure. Types stay static (erased at build).
import type { VerifiedRelease, ReleaseFetchError } from '$net/releaseFetch';
import type { AssetMismatch } from '$net/releaseHashCheck';

/** Frontend bundle version, baked in by Vite's `define`.  See
 *  apps/web/vite.config.js.  TypeScript ambient declaration in
 *  apps/web/src/app.d.ts. */
const RUNNING_VERSION = typeof __MORPHIT_VERSION__ === 'string' ? __MORPHIT_VERSION__ : '0.0.0';

export type ReleaseStoreState =
	| { kind: 'idle' }
	| { kind: 'loading' }
	| { kind: 'ok'; release: VerifiedRelease }
	| { kind: 'error'; error: ReleaseFetchError };

export type AssetCheckState =
	| { kind: 'idle' }
	| { kind: 'loading' }
	| { kind: 'ok' }
	| { kind: 'mismatch'; mismatches: readonly AssetMismatch[] }
	| { kind: 'fetch_failed'; path: string; cause: string };

const releaseStore = writable<ReleaseStoreState>({ kind: 'idle' });
const assetCheckStore = writable<AssetCheckState>({ kind: 'idle' });

/** Reactive store: latest verified release fetch state. */
export const release: Readable<ReleaseStoreState> = {
	subscribe: releaseStore.subscribe
};

/** Reactive store: latest asset-tamper check state. */
export const assetCheck: Readable<AssetCheckState> = {
	subscribe: assetCheckStore.subscribe
};

/** Derived: is the running bundle stale (announced version
 *  differs from running)?  Returns null when we don't know yet
 *  (release fetch in flight or failed).  False when up to date. */
export const staleBuild: Readable<boolean | null> = derived(releaseStore, ($r) => {
	if ($r.kind !== 'ok') return null;
	return $r.release.payload.version !== RUNNING_VERSION;
});

/** Derived: list of asset paths that don't match the signed
 *  manifest.  Empty array when all match (or check not yet
 *  run). */
export const tamperedAssets: Readable<readonly AssetMismatch[]> = derived(assetCheckStore, ($a) => {
	if ($a.kind === 'mismatch') return $a.mismatches;
	return [];
});

/** Derived: chain-pinned treasury addresses (Part 106).
 *
 *  Returns the `treasury` block from the most recent verified
 *  `morphit_release_v1` op, or null when:
 *    - the release fetch hasn't completed yet (idle / loading)
 *    - the fetch failed
 *    - the release op did not include a treasury block
 *
 *  When non-null, callers can render `treasury.btc?.address` and
 *  `treasury.xmr?.address` with confidence that the addresses
 *  were signed by the @morphit posting key.  Each chain may be
 *  null inside the object — operators can pin one chain at a
 *  time.
 *
 *  Used by the post-order page to show users where to send
 *  their listing fee (closes the pre-Part-106 UX gap where the
 *  address was never displayed and operators could social-
 *  engineer alternative addresses).
 */
export const chainPinnedTreasury: Readable<
	import('@morphit/release-schema').ReleaseTreasuryBlock | null
> = derived(releaseStore, ($r) => {
	if ($r.kind !== 'ok') return null;
	return $r.release.payload.treasury ?? null;
});

/** Idempotent boot: kick off the verified fetch + hash check.
 *  Safe to call repeatedly; subsequent calls return immediately
 *  without re-firing. */
let initStarted = false;
export async function initRelease(): Promise<void> {
	if (initStarted) return;
	initStarted = true;

	releaseStore.set({ kind: 'loading' });
	const { fetchVerifiedRelease } = await import('$net/releaseFetch');
	const fetchResult = await fetchVerifiedRelease();
	if (!fetchResult.ok) {
		releaseStore.set({ kind: 'error', error: fetchResult.error });
		return;
	}
	releaseStore.set({ kind: 'ok', release: fetchResult.value });

	// Hash check is independent of the version comparison; both
	// can flag warnings.  Run in the background so the staleBuild
	// banner appears immediately while the tamper check works.
	assetCheckStore.set({ kind: 'loading' });
	try {
		const { checkManifestAgainstRunningBundle } = await import('$net/releaseHashCheck');
		const hashResult = await checkManifestAgainstRunningBundle(
			fetchResult.value.payload.hash_manifest
		);
		if (hashResult.kind === 'ok') {
			assetCheckStore.set({ kind: 'ok' });
		} else if (hashResult.kind === 'mismatch') {
			assetCheckStore.set({
				kind: 'mismatch',
				mismatches: hashResult.mismatches
			});
		} else {
			assetCheckStore.set({
				kind: 'fetch_failed',
				path: hashResult.path,
				cause: hashResult.cause
			});
		}
	} catch (err) {
		// SubtleCrypto unavailable, or unexpected error.  Don't
		// alarm the user — surface as silent failure.  The
		// release-info banner (if any) still renders.
		assetCheckStore.set({
			kind: 'fetch_failed',
			path: '<setup>',
			cause: err instanceof Error ? err.message : String(err)
		});
	}
}

/** Reset for tests / forced refresh. */
export function resetReleaseStore(): void {
	initStarted = false;
	releaseStore.set({ kind: 'idle' });
	assetCheckStore.set({ kind: 'idle' });
}

/** The version baked into this bundle at build time.  Exposed
 *  for callers that want to display it (e.g. about-this-instance
 *  page). */
export const runningVersion: string = RUNNING_VERSION;
