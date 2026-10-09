/**
 * apps/indexer/src/blurt/snapshotCarFetch.ts
 *
 * Get the federation snapshot into THIS box's kubo from a peer's gateway, as a
 * CAR (the trustless "?format=car" answer), when kubo's own swarm cannot fetch
 * it.
 *
 * WHY (morphitlat, 2026-10-08). The snapshot mirror only ran `ipfs pin add`,
 * which asks kubo's swarm. A Tor/I2P-only box has two or three swarm peers and
 * none of them need hold the snapshot, so it could never become a mirror
 * ("could not fetch/pin the snapshot right now"), although the publisher serves
 * it over its own .onion and .b32.i2p. morphit.io's gateway, and its site (the
 * path a peer's .onion reaches), answer `?format=car` with
 * `application/vnd.ipld.car` (checked 2026-10-09, kubo 0.42.0).
 *
 * A CAR carries its blocks under their own hashes, so `ipfs dag import` puts
 * the snapshot in kubo under the SAME CID — a mirror that re-serves exactly what
 * @morphit anchored. The caller then checks the inner dump against the signed
 * sha256 before keeping it, as for any pin.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotSource } from './snapshotMirrors.ts';

/** The snapshot is ~600 kB; anything far larger is not it. */
export const SNAPSHOT_CAR_MAX_BYTES = 64 * 1024 * 1024;
/** One peer's limit (a .b32.i2p tunnel can take minutes to build). */
export const SNAPSHOT_CAR_TIMEOUT_MS = 5 * 60_000;

export interface CarFetchDeps {
	readonly fetch: (
		url: string,
		init: { signal: AbortSignal; redirect: 'manual' }
	) => Promise<Response>;
	/** Put these bytes into kubo and pin `cid` (importCarWith) within
	 *  `budgetMs`; true when pinned. */
	readonly importCar: (
		bytes: Uint8Array,
		cid: string,
		budgetMs?: number
	) => Promise<boolean> | boolean;
	readonly say: (m: string) => void;
	readonly maxBytes?: number;
	readonly timeoutMs?: number;
	/** No peer is asked once less than a minute is left before this (epoch
	 *  ms): the mirror's run has its own limit. */
	readonly deadline?: number;
	readonly now?: () => number;
}

/** Less than this left before the deadline: no further peer is asked. */
const MIN_LEFT_MS = 60_000;

/** The body, read chunk by chunk; null as soon as it passes `max` bytes (the
 *  rest is never read: a peer cannot fill this box's memory). */
async function readCapped(r: Response, max: number): Promise<Uint8Array | null> {
	if (r.body === null) return new Uint8Array(0);
	const reader = r.body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > max) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			parts.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.byteLength;
	}
	return out;
}

/** The trustless CAR URL for a gateway source (`…/ipfs/<cid>`). PURE. */
export function carUrl(sourceUrl: string): string {
	return `${sourceUrl}${sourceUrl.includes('?') ? '&' : '?'}format=car`;
}

/**
 * Try each source in order until one's CAR is imported and pinned under `cid`.
 * Never throws. Local and clearnet sources are skipped: the swarm already had
 * its chance, and a hidden-only node must not reach for clearnet (the sources
 * list omits it there anyway).
 */
export async function pinSnapshotFromPeers(
	sources: readonly SnapshotSource[],
	cid: string,
	deps: CarFetchDeps
): Promise<{ ok: boolean; from?: string }> {
	const max = deps.maxBytes ?? SNAPSHOT_CAR_MAX_BYTES;
	const now = deps.now ?? Date.now;
	const deadline = deps.deadline ?? Number.POSITIVE_INFINITY;
	const peers = sources.filter((s) => s.transport === 'tor' || s.transport === 'i2p');
	if (peers.length === 0) {
		deps.say(
			"no federation peer's .onion or .b32.i2p address was found in the history read, so there is no peer to ask for it."
		);
		return { ok: false };
	}
	for (const s of peers) {
		const left = deadline - now();
		if (left < MIN_LEFT_MS) {
			deps.say('too little of this run is left to ask another peer; the next run asks again.');
			break;
		}
		deps.say(`fetching it from ${s.label} as a CAR …`);
		const ac = new AbortController();
		const timer = setTimeout(
			() => ac.abort(),
			Math.min(deps.timeoutMs ?? SNAPSHOT_CAR_TIMEOUT_MS, left / 2)
		);
		try {
			// A peer's answer never sends this box elsewhere (a clearnet or
			// loopback address): a redirect is not a CAR, and is skipped.
			const r = await deps.fetch(carUrl(s.url), { signal: ac.signal, redirect: 'manual' });
			const type = r.headers.get('content-type') ?? '';
			if (r.status !== 200 || !type.startsWith('application/vnd.ipld.car')) {
				deps.say(`  ${s.label}: HTTP ${r.status}${type ? ` (${type.split(';')[0]})` : ''} — next.`);
				continue;
			}
			const len = Number(r.headers.get('content-length') ?? '0');
			if (len > max) {
				deps.say(`  ${s.label}: ${len} bytes is far larger than the snapshot — next.`);
				continue;
			}
			const bytes = await readCapped(r, max);
			if (bytes === null) {
				deps.say(`  ${s.label}: more than ${max} bytes is not the snapshot — next.`);
				continue;
			}
			if (bytes.length === 0) {
				deps.say(`  ${s.label}: an empty answer is not the snapshot — next.`);
				continue;
			}
			const budget = deadline - now();
			if (budget < MIN_LEFT_MS / 2) {
				deps.say('too little of this run is left to import it; the next run asks again.');
				break;
			}
			if (await deps.importCar(bytes, cid, Number.isFinite(budget) ? budget : undefined))
				return { ok: true, from: s.label };
			deps.say(`  ${s.label}: kubo did not take it under ${cid} — next.`);
		} catch (e) {
			deps.say(`  ${s.label}: ${e instanceof Error ? e.message : String(e)} — next.`);
		} finally {
			clearTimeout(timer);
		}
	}
	return { ok: false };
}

/** One kubo command as its own user; stdout, or null when it failed. */
export type KuboRun = (args: readonly string[], timeoutMs?: number) => string | null;

/**
 * Put a peer's CAR into kubo and pin `cid` from it; true when kubo then holds
 * `cid` pinned. The CAR's own roots are NOT pinned (`--pin-roots=false`): they
 * are whatever the peer declared, and only the anchored CID may stay pinned
 * and be served from this box. Blocks the CAR brought that `cid` does not use
 * are garbage that kubo's GC removes. The file sits in a fresh directory
 * kubo's user can read, and is removed after. Never throws.
 */
export function importCarWith(
	ipfs: KuboRun,
	bytes: Uint8Array,
	cid: string,
	budgetMs = 450_000
): boolean {
	// The import, the pin and the check share the budget (the mirror's run
	// has its own limit).
	const dagMs = Math.max(20_000, Math.min(300_000, Math.floor(budgetMs * 0.6)));
	const pinMs = Math.max(15_000, Math.min(120_000, Math.floor(budgetMs * 0.3)));
	const dir = mkdtempSync(join(tmpdir(), 'morphit-snapshot-car-'));
	try {
		chmodSync(dir, 0o755);
		const file = join(dir, 'snapshot.car');
		writeFileSync(file, bytes, { mode: 0o644 });
		if (ipfs(['dag', 'import', '--pin-roots=false', file], dagMs) === null) return false;
		// The blocks are local now; a CAR that lacks some of them makes this ask
		// the swarm, bounded by its timeout.
		if (ipfs(['pin', 'add', '--recursive', cid], pinMs) === null) return false;
		const held = ipfs(['pin', 'ls', '--type=recursive', cid], 15_000);
		return held !== null && held.includes(cid);
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
