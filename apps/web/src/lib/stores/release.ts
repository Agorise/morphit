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
 *   - Asset hash mismatch → CRITICAL alert, but ONLY when the served
 *     /verify.json version equals the announced version (a genuine
 *     SAME-version byte change).  During a deploy the served build runs
 *     ahead of the chain-pin, so a version-skewed mismatch is skipped
 *     ('deploy_skew') instead of alarmed — routine upgrades no longer
 *     flash the "Build integrity check failed" banner.  When it does
 *     fire, the banner names the affected files.
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
	| { kind: 'deploy_skew' }
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

/** Read the version the operator is CURRENTLY serving, from /verify.json
 *  (same-origin, cache-busted so a proxy can't answer stale). Returns null on
 *  any failure — the caller treats "unknown" the same as "differs": we never
 *  raise the tamper alarm without positive evidence that the served build IS
 *  the chain-pinned one. NOTE: this is a SAME-ORIGIN request to the operator
 *  who already serves the page (and already sees the IP); it is NOT the
 *  sanctioned browser→Blurt-node disclosure, so it adds no privacy cost. */
async function fetchServedVersion(): Promise<string | null> {
	try {
		const { parseDeployedVersion, verifyJsonPollUrl } = await import(
			'$lib/updates/deployedVersion'
		);
		const { fetchWithTimeout } = await import('$net/fetchWithTimeout');
		const res = await fetchWithTimeout(verifyJsonPollUrl(), { cache: 'no-store' });
		if (!res.ok) return null;
		return parseDeployedVersion(await res.text());
	} catch {
		return null;
	}
}

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
		// The hash check re-fetches the SERVED asset bytes and compares them to
		// the chain-pinned manifest. That is only a valid tamper test when the
		// operator is actually serving the chain-pinned build. During a deploy
		// the served build races AHEAD of the chain-pin (the operator broadcasts
		// the matching manifest moments later, in a separate release step), so
		// every served asset mismatches the still-OLD manifest — which is exactly
		// what flashed a false "Build integrity check failed" alarm on routine
		// upgrades. Gate on the served /verify.json version: only run the byte
		// check when it equals the announced version. If it differs — or can't be
		// read — a deploy is in flight (or we lack positive evidence), so we skip
		// rather than cry wolf; the "Load it now" snackbar picks up the new build.
		// Morphit builds are not byte-reproducible across machines, so a version
		// match is the precondition for the byte comparison to mean anything. A
		// GENUINE tamper is a SAME-version byte change, which still trips below.
		//
		// cp508 (tt.txt #3) — ALSO require the RUNNING bundle to be the announced
		// version. The byte check below re-fetches each asset, and those fetches
		// almost always hit the browser/SW cache (the running bundle's own bytes),
		// NOT the network. Right after a deploy — most visibly on mobile, where the
		// service worker keeps serving the previous bundle until it swaps —
		// RUNNING_VERSION is still the OLD build while /verify.json + the chain-pin
		// have already advanced to NEW. The old gate (served === announced) passed,
		// then every OLD cached asset mismatched the NEW manifest → the scary red
		// banner, which only cleared on a SECOND "Load it now" refresh once the SW
		// finally swapped. A stale running bundle is a deploy-skew, not tampering:
		// the staleBuild snackbar already tells the user to reload, so we skip the
		// byte check here. It resumes — and can only ever alarm — once running ===
		// served === announced, i.e. we are genuinely running the operator's
		// current, chain-pinned build.
		const announcedVersion = fetchResult.value.payload.version;
		const servedVersion = await fetchServedVersion();
		if (servedVersion !== announcedVersion || RUNNING_VERSION !== announcedVersion) {
			assetCheckStore.set({ kind: 'deploy_skew' });
			return;
		}

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
