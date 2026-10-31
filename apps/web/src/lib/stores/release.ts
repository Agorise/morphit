/**
 * Morphit — release-trust-anchor store.
 *
 * Single source of truth for "what's the latest officially-released
 * version, are we running it, and is the bundle we're running
 * actually the announced bundle?"
 *
 * Surfaces three reactive flags:
 *
 *   • `release` — the verified release info (or null).
 *   • `staleBuild` — the signed release announces a NEWER version than the one running.
 *   • `tamperedAssets` — non-empty list of assets whose served
 *      bytes don't match the signed manifest.
 *
 * Boot flow:
 *
 *   1. `initRelease()` is called once from `+layout.svelte`'s
 *      onMount.  Subsequent calls are no-ops (the inflight or
 *      completed result is cached in the store).
 *   2. Fetches a verified release via `fetchVerifiedRelease()` —
 *      read through this instance from two RPC operators that agree
 *      (the browser contacts nothing else), signature recovered to the
 *      pinned @morphit key, payload validated — or reuses the outcome
 *      remembered in the last 24 h by any tab of this browser.
 *   3. If verified AND this tab runs the announced version, runs the
 *      hash-manifest check against the files this site serves
 *      (checkRunningBuild). Asynchronous: the staleBuild banner can
 *      render before the check completes.
 *
 * Failure modes don't trigger user-visible alarms unless we have
 * positive evidence:
 *
 *   - No verifiable answer → silent.  We can't tell what the
 *     announced version is.  Showing a "your build might be
 *     stale!" banner with no evidence would be more annoying than
 *     informative.
 *   - Pubkey mismatch → CRITICAL alert.  The newest release op on
 *     chain (as two RPC operators agree) is signed by another key:
 *     either @morphit rotated its key (our pin is stale) or the
 *     account was taken over.  Either way, the release can't be
 *     trusted; the banner says exactly that.  One lying RPC node
 *     cannot cause this; the instance could, on its own site only.
 *   - Asset hash mismatch → CRITICAL alert. The check runs whenever the
 *     running bundle IS the announced version — decided by the build and
 *     the signed release alone; nothing the operator serves (such as
 *     /verify.json) can switch it off. A running bundle of another
 *     version is 'not_checked' (neutral: the staleBuild snackbar offers
 *     the reload), so a routine upgrade never compares old bytes with a
 *     new manifest. The banner names the affected files, and
 *     TamperAlertBanner holds it back while a new service worker is
 *     landing.
 *
 * What the check is worth: it catches a file changed by accident, by a
 * partial compromise of the server, or in transit. It proves nothing
 * against a hostile operator, who serves this code too.
 *
 * No periodic refresh in the store itself.  Releases are
 * infrequent; the chain is asked at most once a day per browser
 * (per running build).  A tab left open for days sees the latest
 * at a page load after the remembered outcome expires.
 */

import { writable, derived, get, type Readable } from 'svelte/store';
// fetchVerifiedRelease (which loads the Blurt crypto library) and
// checkManifestAgainstRunningBundle are dynamically imported: initRelease runs
// in the layout's onMount — NOT at first paint — so deferring them keeps them
// out of every page's baseline modulepreload closure. Types stay static
// (erased at build).
import type { VerifiedRelease, ReleaseFetchError } from '$net/releaseFetch';
import type { AssetMismatch } from '$net/releaseHashCheck';
import { compareReleaseVersions } from '$net/releaseVersion';

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
	/** This tab runs another version than the signed release: there is
	 *  nothing to compare its files with. Neutral, never an alarm. */
	| { kind: 'not_checked'; running: string; announced: string }
	/** Another build's service worker still answers this tab's requests (a
	 *  new one has not taken over yet): the files it could hand out from its
	 *  own store (index.html) are judged once this build's worker does. The
	 *  ones it cannot (its own script, the hashed files) were checked and
	 *  matched. Neutral, never an alarm. */
	| { kind: 'waiting_worker'; worker: string }
	| { kind: 'fetch_failed'; path: string; cause: string }
	/** The signed manifest names something that is not a plain path on this
	 *  site; nothing was fetched. */
	| { kind: 'refused'; path: string };

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

/** Derived: is the running bundle stale (the signed release announces a
 *  NEWER version than the one running)?  Returns null when we don't know yet
 *  (release fetch in flight or failed).  False when up to date — and when the
 *  release read is OLDER than this build (a node may have served an old
 *  genuine release; that must not pass for "an update is landing", which
 *  would hold back the tamper alarm). */
export const staleBuild: Readable<boolean | null> = derived(releaseStore, ($r) => {
	if ($r.kind !== 'ok') return null;
	return compareReleaseVersions($r.release.payload.version, RUNNING_VERSION) > 0;
});

/** Derived: list of asset paths that don't match the signed
 *  manifest.  Empty array when all match (or check not yet
 *  run). */
export const tamperedAssets: Readable<readonly AssetMismatch[]> = derived(assetCheckStore, ($a) => {
	if ($a.kind === 'mismatch') return $a.mismatches;
	return [];
});

/** Derived: chain-pinned treasury addresses.
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
 *  their listing fee (closes the older UX gap where the
 *  address was never displayed and operators could social-
 *  engineer alternative addresses).
 */
export const chainPinnedTreasury: Readable<
	import('@morphit/release-schema').ReleaseTreasuryBlock | null
> = derived(releaseStore, ($r) => {
	if ($r.kind !== 'ok') return null;
	return $r.release.payload.treasury ?? null;
});

/** What the about-this-instance page shows for the integrity check: a
 *  per-file count against the signed release's manifest (the files that
 *  start the app), never a value the signed release does not carry. */
export type IntegritySummary =
	/** The signed release or the file check is still being read. */
	| { kind: 'pending' }
	/** The signed release could not be read, so there is nothing to check
	 *  against. */
	| { kind: 'no_release' }
	| { kind: 'not_checked'; running: string; announced: string }
	/** Another build's service worker still runs this tab: checked once the
	 *  new one takes over. */
	| { kind: 'waiting_worker' }
	/** The only signed release read is older than this build: the current
	 *  release could not be confirmed, so nothing was compared. */
	| { kind: 'unconfirmed'; running: string; announced: string }
	| { kind: 'checked'; matched: number; total: number; version: string }
	/** A signed file could not be read or hashed: no verdict. */
	| { kind: 'incomplete'; version: string };

export const integritySummary: Readable<IntegritySummary> = derived(
	[releaseStore, assetCheckStore],
	([$r, $a]): IntegritySummary => {
		if ($r.kind === 'error') {
			return $r.error.kind === 'older_release'
				? { kind: 'unconfirmed', running: RUNNING_VERSION, announced: $r.error.announced }
				: { kind: 'no_release' };
		}
		if ($r.kind !== 'ok') return { kind: 'pending' };
		const version = $r.release.payload.version;
		const total = Object.keys($r.release.payload.hash_manifest).length;
		switch ($a.kind) {
			case 'ok':
				return { kind: 'checked', matched: total, total, version };
			case 'mismatch':
				return { kind: 'checked', matched: total - $a.mismatches.length, total, version };
			case 'not_checked':
				return { kind: 'not_checked', running: $a.running, announced: $a.announced };
			case 'waiting_worker':
				return { kind: 'waiting_worker' };
			case 'fetch_failed':
			case 'refused':
				return { kind: 'incomplete', version };
			default:
				return { kind: 'pending' };
		}
	}
);

/** This build's SvelteKit id ($app/environment `version`, what its service
 *  worker reports), or null where there is none (a script run outside
 *  SvelteKit). Loaded when needed: a static import of $app breaks every
 *  script that loads this store under plain tsx. */
async function thisBuild(): Promise<string | null> {
	try {
		const { version } = await import('$app/environment');
		return typeof version === 'string' && version !== '' ? version : null;
	} catch {
		return null;
	}
}

/** The build of the service worker that answers this tab's requests (its
 *  RELEASE_INFO answer to CHECK_UPDATE, src/service-worker.ts), or null when
 *  none does, or it does not answer within `timeoutMs`. */
export async function controllingWorkerBuild(timeoutMs = 3_000): Promise<string | null> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
	const sw = navigator.serviceWorker;
	const controller = sw.controller;
	if (controller === null) return null;
	return new Promise<string | null>((resolve) => {
		const finish = (v: string | null): void => {
			clearTimeout(timer);
			sw.removeEventListener('message', onMessage);
			resolve(v);
		};
		const onMessage = (e: MessageEvent): void => {
			const d = e.data as { type?: unknown; installed?: unknown } | null;
			if (d?.type === 'RELEASE_INFO' && typeof d.installed === 'string') finish(d.installed);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		sw.addEventListener('message', onMessage);
		try {
			controller.postMessage({ type: 'CHECK_UPDATE' });
		} catch {
			finish(null);
		}
	});
}

/** The build-integrity check for a verified release: when this tab runs the
 *  announced version, fetch each file the signed manifest lists from this
 *  site and compare its hash. Decided by the running build and the signed
 *  release ALONE — what the operator's /verify.json says (missing, or
 *  another version) is not consulted, so it cannot switch the check off.
 *
 *  Why the running version, and only it: the files are re-fetched mostly
 *  from the browser / service-worker cache, i.e. the running bundle's own
 *  bytes, and Morphit builds are not byte-reproducible across machines. A
 *  tab still running an older (or newer) build than the signed release has
 *  nothing to compare — 'not_checked', and nothing is fetched.
 *
 *  While another build's service worker answers this tab (it keeps doing so
 *  until the new one takes over) it hands out its own stored copies, and an
 *  earlier release's index.html showed the red banner on a site serving the
 *  signed release exactly (vigilante.trading, 2026-10-30). Then only the
 *  files that worker cannot answer from its store are judged — its own
 *  script (a worker never stores it) and the hashed /_app/immutable/ files
 *  (same name, same bytes) — so a changed /service-worker.js still raises the
 *  alarm; the rest waits ('waiting_worker') and is checked on the takeover. */
export async function checkRunningBuild(
	announced: { readonly version: string; readonly hash_manifest: Readonly<Record<string, string>> },
	running: string = RUNNING_VERSION,
	workers: {
		readonly own: () => Promise<string | null>;
		readonly controlling: () => Promise<string | null>;
	} = {
		own: thisBuild,
		controlling: () => controllingWorkerBuild()
	}
): Promise<AssetCheckState> {
	if (running !== announced.version) {
		return { kind: 'not_checked', running, announced: announced.version };
	}
	const worker = await workers.controlling();
	const own = worker === null ? null : await workers.own();
	// This build's id unknown (outside SvelteKit): judged as before.
	const foreignWorker = worker !== null && own !== null && worker !== own;
	try {
		const { checkManifestAgainstRunningBundle, manifestKeyToSameOriginPath } = await import(
			'$net/releaseHashCheck'
		);
		let manifest: Readonly<Record<string, string>> = announced.hash_manifest;
		if (foreignWorker) {
			const sure: Record<string, string> = {};
			for (const [key, hash] of Object.entries(manifest)) {
				const path = manifestKeyToSameOriginPath(key);
				// A key that is not a plain path on this site refuses the whole
				// manifest, as below.
				if (path === null) return { kind: 'refused', path: key };
				if (path === '/service-worker.js' || path.startsWith('/_app/immutable/')) sure[key] = hash;
			}
			manifest = sure;
		}
		const r = await checkManifestAgainstRunningBundle(manifest);
		if (foreignWorker && r.kind === 'ok') return { kind: 'waiting_worker', worker };
		if (r.kind === 'ok') return { kind: 'ok' };
		if (r.kind === 'mismatch') return { kind: 'mismatch', mismatches: r.mismatches };
		if (r.kind === 'refused') return { kind: 'refused', path: r.path };
		return { kind: 'fetch_failed', path: r.path, cause: r.cause };
	} catch (err) {
		// Unexpected error (e.g. no hash function at all): no verdict, never an
		// alarm without evidence.
		return {
			kind: 'fetch_failed',
			path: '<setup>',
			cause: err instanceof Error ? err.message : String(err)
		};
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
	// The outcome — a verified release or a failure — is remembered in this
	// browser for 24 h, per running build ($net/releaseCache), so a browser
	// reaches the Blurt nodes (the one third-party request) at most once a day.
	const {
		readCachedOutcome,
		writeCachedOutcome,
		readNewestVerified,
		decideReleaseOutcome,
		RELEASE_CHECK_CLAIM_KEY
	} = await import('$net/releaseCache');
	const { safeLocal } = await import('$lib/utils/safeStorage');
	const storage = {
		getItem: (k: string) => safeLocal.get(k),
		setItem: (k: string, v: string) => void safeLocal.set(k, v),
		removeItem: (k: string) => void safeLocal.remove(k),
		keys: (): string[] => {
			const out: string[] = [];
			try {
				const s = window.localStorage;
				for (let i = 0; i < s.length; i++) {
					const k = s.key(i);
					if (k !== null) out.push(k);
				}
			} catch {
				/* storage unavailable: no claims to see */
			}
			return out;
		}
	};
	type Outcome = { ok: true; value: VerifiedRelease } | { ok: false; error: ReleaseFetchError };
	const peek = (): Outcome | null => {
		const cached = readCachedOutcome(storage, Date.now(), RUNNING_VERSION);
		if (cached === null) return null;
		return cached.ok
			? { ok: true, value: cached.value as VerifiedRelease }
			: { ok: false, error: cached.error as ReleaseFetchError };
	};
	// Every tab shares that outcome; tabs opened together run ONE check
	// between them ($net/onceAcrossTabs), so the budget holds per browser.
	const { onceAcrossTabs } = await import('$net/onceAcrossTabs');
	const locks =
		typeof navigator !== 'undefined' &&
		(navigator as { locks?: unknown }).locks &&
		typeof (navigator as { locks: { request?: unknown } }).locks.request === 'function'
			? (navigator as unknown as { locks: import('$net/onceAcrossTabs').LockManagerLike }).locks
			: null;
	const fetchResult: Outcome =
		peek() ??
		(await onceAcrossTabs<Outcome>({
			name: 'morphit-release-check',
			claimKey: RELEASE_CHECK_CLAIM_KEY,
			locks,
			storage,
			peek,
			run: async () => {
				const { fetchVerifiedRelease } = await import('$net/releaseFetch');
				const fetched = await fetchVerifiedRelease();
				// A verified release OLDER than this build is not the current one: it
				// never supplies the treasury; a newer release this browser verified
				// does, or the outcome is 'older_release' — re-checked within the hour
				// ($net/releaseCache decideReleaseOutcome).
				const d = decideReleaseOutcome(fetched, readNewestVerified(storage), RUNNING_VERSION);
				writeCachedOutcome(storage, Date.now(), RUNNING_VERSION, d.outcome, {
					ttlMs: d.ttlMs,
					newest: d.newest
				});
				const r = d.outcome as Outcome;
				if (r.ok) {
					// Keep the treasury BTC key of every release this browser verified:
					// an order numbered under it before a key rotation is then checked
					// against it with no further request ($lib/orders/btcFeeKeyHistory).
					const { rememberPinnedBtcXpub } = await import('$lib/orders/btcFeeKeyHistory');
					rememberPinnedBtcXpub(r.value.payload.treasury?.btc?.xpub);
				}
				return r;
			}
		}));
	if (!fetchResult.ok) {
		releaseStore.set({ kind: 'error', error: fetchResult.error });
		return;
	}
	releaseStore.set({ kind: 'ok', release: fetchResult.value });

	// The release is published above, so the staleBuild banner can render
	// while the tamper check works.
	assetCheckStore.set({ kind: 'loading' });
	const payload = fetchResult.value.payload;
	const checked = await checkRunningBuild(payload);
	assetCheckStore.set(checked);
	// Checked once this build's own worker takes over (after "Load it now", or
	// when the last tab of the old one closes).
	if (checked.kind === 'waiting_worker' && typeof navigator !== 'undefined') {
		navigator.serviceWorker?.addEventListener(
			'controllerchange',
			() => void checkRunningBuild(payload).then((r) => assetCheckStore.set(r)),
			{ once: true }
		);
	}
}

/** "Try again" after a failed check, on the user's explicit request (the fee
 *  panels offer it while the release is unknown or unconfirmed). A remembered
 *  failure would otherwise stand for 24 h (an older-than-this-build answer, 1
 *  h); this forgets it and runs the check once more. A verified release is
 *  never discarded this way, nor the newest one this browser verified. */
export async function retryReleaseCheck(): Promise<void> {
	const current = get(releaseStore);
	if (
		current.kind !== 'error' ||
		(current.error.kind !== 'rpc_failed' && current.error.kind !== 'older_release')
	)
		return;
	const { forgetCachedOutcome } = await import('$net/releaseCache');
	const { safeLocal } = await import('$lib/utils/safeStorage');
	forgetCachedOutcome({
		getItem: (k) => safeLocal.get(k),
		setItem: (k, v) => void safeLocal.set(k, v),
		removeItem: (k) => void safeLocal.remove(k)
	});
	initStarted = false;
	await initRelease();
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
