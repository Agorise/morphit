/**
 * Smoke: the on-disk profile cache ($lib/indexer/profilePersist +
 * profileCache) — fast, and not a record of whom this browser looked at.
 *
 * Runs the real modules against an in-memory IndexedDB stand-in (that keeps
 * its data across a simulated reload) and a fake indexer, and checks:
 *
 *   SPEED (why the store exists)
 *   - a profile fetched once renders from disk after a reload, no request;
 *   - only POSITIVE network answers are written (never a "no profile");
 *   - with no IndexedDB at all (SSR / private mode) nothing throws;
 *   - the user's own update drops their on-disk copy.
 *
 *   PRIVACY
 *   - records are filed per signed-in account: another account on the same
 *     device does not read the list;
 *   - a record past the persistent TTL is deleted, not kept;
 *   - an explicit Sign Out empties the store;
 *   - a stale disk hit is refreshed with an ORDINARY request, never with
 *     `cache: 'reload'` (which would tell the operator the browser had it);
 *   - logged out, nothing is filed on disk, and a returning visit sends the
 *     same requests as a browser that never came (no link across IPs).
 *
 * Usage: tsx --tsconfig apps/web/tsconfig.smoke.json apps/web/scripts/profile-persistent-cache-smoke.ts
 */

// ─── an in-memory IndexedDB (only what profilePersist uses) ────────────────
type Row = Record<string, unknown>;
const databases = new Map<
	string,
	{ version: number; stores: Map<string, { keyPath: string | string[]; rows: Map<string, Row> }> }
>();
const later = (fn: () => void): void => void setTimeout(fn, 0);
const keyOf = (v: unknown): string => JSON.stringify(v);

function fakeIndexedDb() {
	return {
		open(name: string, version: number) {
			const req: Record<string, unknown> & {
				result?: unknown;
				onupgradeneeded?: () => void;
				onsuccess?: () => void;
			} = {};
			later(() => {
				let dbState = databases.get(name);
				const upgrade = !dbState || dbState.version < version;
				if (!dbState) {
					dbState = { version, stores: new Map() };
					databases.set(name, dbState);
				}
				const state = dbState;
				const db = {
					objectStoreNames: { contains: (n: string) => state.stores.has(n) },
					createObjectStore(n: string, opts: { keyPath: string | string[] }) {
						state.stores.set(n, { keyPath: opts.keyPath, rows: new Map() });
					},
					deleteObjectStore(n: string) {
						state.stores.delete(n);
					},
					onversionchange: null as unknown,
					close() {},
					transaction(n: string) {
						const store = state.stores.get(n);
						if (!store) throw new Error(`no store ${n}`);
						const tx: {
							oncomplete?: () => void;
							onerror?: () => void;
							onabort?: () => void;
							objectStore: () => unknown;
						} = {
							objectStore: () => ({
								get(key: unknown) {
									const r: { result?: unknown; onsuccess?: () => void } = {};
									later(() => {
										r.result = store.rows.get(keyOf(key));
										r.onsuccess?.();
									});
									return r;
								},
								put(value: Row) {
									const kp = store.keyPath;
									const key = Array.isArray(kp) ? kp.map((k) => value[k]) : value[kp];
									store.rows.set(keyOf(key), structuredClone(value));
								},
								delete(key: unknown) {
									store.rows.delete(keyOf(key));
								},
								clear() {
									store.rows.clear();
								}
							})
						};
						setTimeout(() => tx.oncomplete?.(), 5);
						return tx;
					}
				};
				req.result = db;
				if (upgrade) {
					state.version = version;
					req.onupgradeneeded?.();
				}
				req.onsuccess?.();
			});
			return req;
		}
	};
}

// ─── a page on https://morphit.example, and a fake indexer ─────────────────
Object.assign(globalThis, {
	window: { location: new URL('https://morphit.example/en') },
	location: new URL('https://morphit.example/en')
});
const requests: { accounts: string[]; cache: RequestCache | undefined }[] = [];
const indexerProfiles = new Map<string, unknown>();
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
	const url = new URL(String(input));
	const accounts = (url.searchParams.get('accounts') ?? '').split(',').filter(Boolean);
	requests.push({ accounts, cache: init?.cache });
	const profiles: Record<string, unknown> = {};
	for (const a of accounts) if (indexerProfiles.has(a)) profiles[a] = indexerProfiles.get(a);
	return new Response(JSON.stringify({ profiles }), { status: 200 });
}) as typeof fetch;

const profileOf = (account: string) => ({
	account,
	display_name: `${account} display`,
	avatar: null
});

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

async function main(): Promise<void> {
	const persist = await import('../src/lib/indexer/profilePersist.ts');
	const cache = await import('../src/lib/indexer/profileCache.ts');

	// No IndexedDB at all.
	{
		delete (globalThis as { indexedDB?: unknown }).indexedDB;
		indexerProfiles.set('alice', profileOf('alice'));
		let threw = false;
		try {
			await cache.getProfilesBatch(['alice', 'bob']);
			await cache.forgetProfilesOnSignOut();
		} catch {
			threw = true;
		}
		check('without IndexedDB (SSR / private mode) nothing throws', !threw);
	}

	(globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDb();
	/** A page reload: memory gone, IndexedDB contents kept. */
	const reload = (): void => {
		cache.clearProfileCache(); // memory gone, disk kept
		persist._resetProfilePersistForTests();
	};

	// Read-through after a reload, positives only.
	reload();
	cache.setProfileCacheScope('carol');
	indexerProfiles.set('alice', profileOf('alice'));
	await cache.getProfilesBatch(['alice', 'nobody']);
	await settle();
	reload();
	cache.setProfileCacheScope('carol');
	requests.length = 0;
	const again = await cache.getProfilesBatch(['alice']);
	check(
		'a profile seen once renders from disk after a reload, with no request',
		(again.get('alice') as { display_name?: string } | null)?.display_name === 'alice display' &&
			requests.length === 0,
		`${requests.length} request(s)`
	);
	requests.length = 0;
	await cache.getProfilesBatch(['nobody']);
	check('a "no profile" answer is never written to disk', requests.length === 1);

	// Own update drops the disk copy.
	cache.primeProfile('alice', { displayName: 'alice, renamed' });
	await settle();
	reload();
	cache.setProfileCacheScope('carol');
	requests.length = 0;
	await cache.getProfilesBatch(['alice']);
	check("the user's own update drops their on-disk copy", requests.length === 1);
	await settle();

	// Per-account scope.
	reload();
	cache.setProfileCacheScope('dave');
	requests.length = 0;
	await cache.getProfilesBatch(['alice']);
	check(
		'another account on this device does not read the list (asks the network)',
		requests.length === 1 && requests[0]!.accounts.includes('alice')
	);
	await settle();

	// Stale hit: served, refreshed with an ordinary request.
	reload();
	cache.setProfileCacheScope('dave');
	const realNow = Date.now;
	Date.now = () => realNow() + 10 * 60_000; // 10 min later: past the 90 s memory TTL
	requests.length = 0;
	const stale = await cache.getProfilesBatch(['alice']);
	await settle();
	check('a stale disk hit is served at once', stale.get('alice') !== null);
	check(
		"…and refreshed with an ordinary request, never cache: 'reload'",
		requests.length === 1 && requests[0]!.cache === undefined,
		JSON.stringify(requests)
	);

	// Past the persistent TTL: deleted.
	reload();
	cache.setProfileCacheScope('dave');
	Date.now = () => realNow() + 8 * 24 * 60 * 60_000; // 8 days later
	await persist.idbGetProfiles(['alice'], 7 * 24 * 60 * 60_000);
	Date.now = realNow;
	const rows = [...databases.get('morphit-profiles')!.stores.get('profiles')!.rows.values()];
	check(
		'a record past the persistent TTL is deleted, not kept',
		// The record this read found (dave's copy; a store without scopes has one copy).
		!rows.some((r) => r.account === 'alice' && (r.scope === undefined || r.scope === '@dave')),
		JSON.stringify(rows.map((r) => [r.scope, r.account]))
	);

	// Logged out: a returning visit must not differ on the wire from a first
	// one. A visitor's IP changes between visits (Tor circuit, VPN exit); if
	// what the browser asks depends on what it saw before, the operator links
	// the visits — and can plant accounts on a page to test for them.
	{
		for (const a of ['alice', 'bob', 'evil', 'carol', 'newcomer'])
			indexerProfiles.set(a, profileOf(a));
		const visit = async (accounts: string[]): Promise<string[]> => {
			reload();
			cache.setProfileCacheScope(null);
			requests.length = 0;
			await cache.getProfilesBatch(accounts);
			await settle();
			return requests.map((r) => [...r.accounts].sort().join(',')).sort();
		};
		await visit(['alice', 'bob', 'evil', 'carol']);
		const anonRows = [...databases.get('morphit-profiles')!.stores.get('profiles')!.rows.values()]
			.filter((r) => r.scope === 'anon')
			.map((r) => r.account);
		check(
			'a logged-out visit files nothing on disk',
			anonRows.length === 0,
			`filed: ${anonRows.join(', ')}`
		);
		Date.now = () => realNow() + 10 * 60_000; // the next visit, 10 min later
		const returning = await visit(['newcomer', 'evil']);
		databases.delete('morphit-profiles'); // a browser that never came here
		const fresh = await visit(['newcomer', 'evil']);
		Date.now = realNow;
		check(
			'a returning logged-out visit asks exactly what a fresh browser asks',
			JSON.stringify(returning) === JSON.stringify(fresh),
			`returning ${JSON.stringify(returning)} vs fresh ${JSON.stringify(fresh)}`
		);
	}

	// Sign-out empties the store.
	cache.setProfileCacheScope('carol');
	indexerProfiles.set('erin', profileOf('erin'));
	await cache.getProfilesBatch(['erin']);
	await settle();
	await cache.forgetProfilesOnSignOut();
	const left = databases.get('morphit-profiles')!.stores.get('profiles')!.rows.size;
	check(
		'an explicit Sign Out empties the store (every account)',
		left === 0,
		`${left} row(s) left`
	);

	console.log('');
	if (failed > 0) {
		console.log(`✗ ${failed} profile-persistent-cache scenario(s) FAILED`);
		process.exit(1);
	}
	console.log(`✓ all ${passed} profile-persistent-cache scenarios passed`);
	process.exit(0);
}

void main();
