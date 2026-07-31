/**
 * Smoke: the profile cache must PERSIST resolved avatars/display names across
 * reloads (IndexedDB), so a device that has seen an account before renders its
 * custom avatar/name instantly with no network wait and no identicon flash.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ken (t.txt): custom avatars + display names "STILL taking up to 7 seconds to
 * appear for some accounts … cache all avatars and display names the moment
 * they need to be loaded for the first time … for users that have a custom
 * avatar and/or display name set, i do not EVER want to see their identicon
 * and/or @username. it needs to be instantaneous."
 *
 * The in-MEMORY cache dies on reload, so every fresh tab / hard reload / next
 * day paid the ~7s round-trip and flashed the loading skeleton again. This
 * smoke pins the disk layer that fixes it: `profilePersist.ts` (a gracefully
 * degrading IndexedDB store) plus the read-through / write-through / invalidate
 * wiring in `profileCache.ts`. It also guards the two invariants that keep the
 * persistence SAFE — only POSITIVE profiles are ever written (never an absence,
 * which would pin a not-yet-indexed profile across reloads), and every disk op
 * is best-effort and never throws (so persistence can only make things faster,
 * never break rendering).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

const persist = read('apps/web/src/lib/indexer/profilePersist.ts');
const cache = read('apps/web/src/lib/indexer/profileCache.ts');

let checks = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
	checks++;
	if (ok) {
		console.log(`  \u2713 ${label}`);
	} else {
		failed++;
		console.log(`  \u2717 ${label}`);
	}
}

console.log('\u2500\u2500 profile persistent cache (IndexedDB) wiring \u2500\u2500');

// ---- profilePersist.ts: the disk store ---------------------------------
check(
	'profilePersist exports idbGetProfiles / idbPutProfiles / idbDeleteProfile',
	/export\s+async\s+function\s+idbGetProfiles/.test(persist) &&
		/export\s+async\s+function\s+idbPutProfiles/.test(persist) &&
		/export\s+async\s+function\s+idbDeleteProfile/.test(persist)
);
check(
	'persistence degrades gracefully when IndexedDB is unavailable (SSR / private mode)',
	persist.includes("typeof indexedDB === 'undefined'")
);
check(
	'every disk path is wrapped so it never throws (try/catch + resolve-fallback)',
	(persist.match(/try\s*\{/g)?.length ?? 0) >= 3 && persist.includes('catch')
);
check(
	'open failures resolve to null (no persistence) rather than rejecting',
	persist.includes('req.onerror = () => resolve(null)') &&
		persist.includes('req.onblocked = () => resolve(null)')
);

// ---- profileCache.ts: read-through / write-through / invalidate ---------
check(
	'profileCache imports the disk layer',
	/import\s*\{[^}]*idbGetProfiles[^}]*idbPutProfiles[^}]*idbDeleteProfile[^}]*\}\s*from\s*'\$lib\/indexer\/profilePersist'/.test(
		cache
	) || (cache.includes('idbGetProfiles') && cache.includes('idbPutProfiles') && cache.includes('idbDeleteProfile'))
);
check(
	'disk is read THROUGH before the network (read-through), and skipped on reload',
	cache.includes('await idbGetProfiles(toResolve)') && cache.includes('if (!opts?.reload)')
);
check(
	'disk read-through is registered inside the shared resolution (in-flight dedup preserved)',
	cache.includes('const resolution: Promise<Map<string, Resolved>>') &&
		cache.includes('inFlight.set(account, perAccountPromise)')
);
check(
	'resolved profiles are written THROUGH to disk (write-through)',
	cache.includes('void idbPutProfiles(toPersist)')
);
check(
	'ONLY positive, network-fetched profiles are persisted — never a null/absence, never a disk echo',
	cache.includes('if (!failed && value !== null && !fromDisk)')
);
check(
	'a stale disk hit is served immediately AND queued for background revalidation (SWR)',
	cache.includes('staleRevalidate.push(account)') &&
		cache.includes('void getProfilesBatch(staleRevalidate, undefined, { reload: true })')
);
check(
	'the persistent TTL is far longer than the 90s memory TTL (days-scale)',
	/PERSIST_TTL_MS\s*=\s*\d+\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(cache) &&
		cache.includes('const CACHE_TTL_MS = 90_000')
);
check(
	"the user's own update invalidates the on-disk copy (prime + targeted clear)",
	(cache.match(/void idbDeleteProfile\(account\)/g)?.length ?? 0) >= 2
);
check(
	'a prime landing during the disk read is not clobbered by a disk value',
	cache.includes('!isPrimeHeld(account) && now - rec.fetchedAt < PERSIST_TTL_MS')
);

if (failed > 0) {
	console.log(`\n\u2717 ${failed} of ${checks} profile-persistent-cache checks FAILED`);
	process.exit(1);
}
console.log(`\n\u2713 all ${checks} profile-persistent-cache scenarios passed`);
process.exit(0);
