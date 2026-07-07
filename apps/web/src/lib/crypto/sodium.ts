/**
 * Lazy libsodium accessor.
 *
 * libsodium-wrappers-sumo is ~1 MB (the WASM is inlined into the JS
 * bundle, no separate .wasm). Statically `import`ing it anywhere drags
 * that 1 MB into the route's modulepreload closure — and because the
 * shared `[lang]` layout reaches `$crypto/keystore` + `$crypto/keygen`
 * via `$stores/identity`, a static import there put the whole 1 MB on
 * EVERY page's first load (home, orderbook, …), even pages that never
 * touch crypto. (cp267: measured 1040 KB in the per-page baseline.)
 *
 * Instead we keep a single module-level `sodium` binding that is
 * populated by a DYNAMIC `import()` the first time `ensureSodium()` is
 * awaited. Because ESM exports are live bindings, every module that does
 * `import { sodium } from './sodium'` sees the populated value once the
 * load resolves — so existing `sodium.xxx(...)` call sites are unchanged.
 *
 * Contract for callers:
 *   - ASYNC functions MUST `await ensureSodium()` before touching
 *     `sodium`. (keygen/keystore already do.)
 *   - SYNC functions (e.g. the memzero wipes, toLiveIdentity,
 *     decryptIdentityFromCek, pickRandomIndices) may read `sodium`
 *     directly ONLY because they can only ever run after an async
 *     crypto function has already loaded it — you cannot have a key to
 *     wipe, a CEK to open, or a generated identity to quiz without
 *     having first awaited ensureSodium(). Do NOT introduce a sync
 *     `sodium.*` call on a cold path.
 *
 * libsodium thus loads exactly once, lazily, only when crypto is first
 * actually used (sign-in unlock, onboarding "Create", chat, import, …).
 */

type SodiumApi = typeof import('libsodium-wrappers-sumo')['default'];

/**
 * The libsodium API. `undefined` until the first `ensureSodium()`
 * resolves; populated thereafter (live binding — importers see it).
 */
export let sodium: SodiumApi = undefined as unknown as SodiumApi;

/** Cached so concurrent/repeat callers share one load + ready await. */
let readyPromise: Promise<void> | null = null;

/**
 * Dynamically import libsodium, await its WASM init, and publish it on
 * the `sodium` binding. Idempotent: the first call kicks off the load,
 * every later call awaits the same promise.
 */
export async function ensureSodium(): Promise<void> {
	if (readyPromise) return readyPromise;
	readyPromise = (async () => {
		const mod = await import('libsodium-wrappers-sumo');
		await mod.default.ready;
		sodium = mod.default;
	})();
	return readyPromise;
}
