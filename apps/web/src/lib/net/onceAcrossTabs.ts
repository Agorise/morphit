/**
 * Run a check once for the whole browser, not once per tab.
 *
 * The release check's outcome is shared by every tab through localStorage
 * (./releaseCache.ts), but two tabs opened together would both find the cache
 * empty and both ask the nodes. This makes the others wait for one of them and
 * then read what it stored:
 *
 *   - with the Web Locks API (secure pages): an exclusive lock named `name`;
 *     whoever holds it re-reads the cache (`peek`) first, then runs;
 *   - without it (plain-http pages, e.g. .i2p, or .onion outside Tor
 *     Browser): an ELECTION over storage. localStorage reaches other tabs'
 *     processes asynchronously, so a read-then-write of one shared key lets
 *     two tabs both "win". Instead each candidate writes its OWN claim key
 *     (`claimKey.<id>` = time), waits `settleMs` for the other tabs' claims to
 *     arrive, then re-reads every fresh claim: the earliest (time, then id)
 *     wins and runs; every other tab withdraws and polls the cache until it
 *     fills or the winner's claim goes stale (`claimTtlMs`: a tab closed
 *     mid-check leaves a claim that simply expires). All tabs see the same set
 *     of claims, so they agree on the winner.
 *
 * Pure apart from what is injected.
 */

export interface LockManagerLike {
	request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface ClaimStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
	/** Every key currently in the storage area. */
	keys(): readonly string[];
}

export interface OnceAcrossTabsOptions<T> {
	/** Lock name (Web Locks). */
	readonly name: string;
	/** Storage key of the claim (no Web Locks). */
	readonly claimKey: string;
	readonly locks: LockManagerLike | null;
	readonly storage: ClaimStorage | null;
	/** The shared result, if another tab already produced it. */
	readonly peek: () => T | null;
	/** Produce the result (and store it where `peek` finds it). */
	readonly run: () => Promise<T>;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly claimTtlMs?: number;
	readonly pollMs?: number;
	/** How long a candidate waits for other tabs' claims before electing. */
	readonly settleMs?: number;
}

interface Claim {
	readonly id: string;
	readonly at: number;
}

/** Every fresh claim in storage (`claimKey.<id>` = time). */
function freshClaims(storage: ClaimStorage, prefix: string, now: number, ttl: number): Claim[] {
	const out: Claim[] = [];
	let keys: readonly string[];
	try {
		keys = storage.keys();
	} catch {
		return out;
	}
	for (const k of keys) {
		if (!k.startsWith(prefix)) continue;
		const at = Number(storage.getItem(k));
		if (!Number.isFinite(at) || now - at >= ttl || at > now + ttl) continue;
		out.push({ id: k.slice(prefix.length), at });
	}
	return out;
}

const earliest = (a: Claim, b: Claim): Claim =>
	a.at < b.at || (a.at === b.at && a.id < b.id) ? a : b;

/** Unique per call, across tabs. */
function claimId(): string {
	const bytes = new Uint8Array(12);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function onceAcrossTabs<T>(o: OnceAcrossTabsOptions<T>): Promise<T> {
	if (o.locks !== null) {
		return o.locks.request(o.name, async () => o.peek() ?? (await o.run()));
	}
	const storage = o.storage;
	if (storage === null) return o.peek() ?? (await o.run());

	const now = o.now ?? (() => Date.now());
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const ttl = o.claimTtlMs ?? 120_000;
	const poll = o.pollMs ?? 500;
	const settle = o.settleMs ?? 400;
	const prefix = `${o.claimKey}.`;
	const id = claimId();
	const mine = `${prefix}${id}`;
	const withdraw = (): void => {
		try {
			storage.removeItem(mine);
		} catch {
			/* nothing to do */
		}
	};
	const until = now() + ttl;
	for (;;) {
		const hit = o.peek();
		if (hit !== null) return hit;
		if (now() >= until) break; // a winner that never finished: run ourselves
		if (freshClaims(storage, prefix, now(), ttl).length > 0) {
			await sleep(poll); // another tab is running the check
			continue;
		}
		try {
			storage.setItem(mine, String(now()));
		} catch {
			break; // private mode: run unclaimed
		}
		await sleep(settle);
		const claims = freshClaims(storage, prefix, now(), ttl);
		const winner = claims.reduce<Claim | null>((w, c) => (w === null ? c : earliest(w, c)), null);
		if (winner === null || winner.id === id) break;
		withdraw();
	}
	try {
		return o.peek() ?? (await o.run());
	} finally {
		withdraw();
	}
}
