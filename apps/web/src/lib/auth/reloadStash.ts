/**
 * The reload stash: how an unlocked "Remember me" session survives a plain
 * page reload without the password, without its keys ever reaching disk.
 *
 * On `pagehide` the page encrypts the session (libsodium secretbox) under a
 * fresh random 32-byte key and keeps only the CIPHERTEXT in this tab's
 * sessionStorage. The key goes to the service worker, which holds it in
 * memory — never in storage — for at most RELOAD_STASH_MAX_AGE_MS and hands
 * it out once. The next load asks the service worker for the key, decrypts,
 * and both copies are gone.
 *
 * So what a browser writes to disk (Chromium's sessionStorage database,
 * Firefox's session-restore file) is ciphertext whose key lives only in a
 * running service worker's memory: it is useless once the worker stops, the
 * browser closes, or 30 seconds pass. A hard reload (no controlling service
 * worker) or a browser without service workers (Tor Browser) simply locks.
 *
 * This module holds the pieces both sides share: the record format, sealing
 * and opening (page side), and the key holder (service-worker side). The
 * gating — Remember-me session only, real reloads only — is in
 * $stores/identity.
 */

/** sessionStorage key of the encrypted stash. */
export const RELOAD_STASH_KEY = 'morphit.session.reload-stash-v2';
/** Written by older builds with the session in PLAINTEXT. Deleted on sight
 *  and never read. */
export const LEGACY_RELOAD_STASH_KEYS: readonly string[] = ['morphit.session.reload-stash-v1'];

/** A stash (and its key) older than this is worthless. A reload re-runs the
 *  page within a second or two; 30 s leaves room for a slow Tor/I2P reload. */
export const RELOAD_STASH_MAX_AGE_MS = 30_000;

/** page → service worker: keep this key for the stash `id`. */
export const SW_STASH_PUT = 'RELOAD_STASH_PUT';
/** page → service worker (with a MessagePort): hand over and forget the key
 *  for `id`; replies `{ key: Uint8Array | null }` on the port. */
export const SW_STASH_TAKE = 'RELOAD_STASH_TAKE';

/** The libsodium calls the stash needs (the page passes the loaded library). */
export interface StashSodium {
	randombytes_buf(n: number): Uint8Array;
	crypto_secretbox_easy(m: Uint8Array, n: Uint8Array, k: Uint8Array): Uint8Array;
	crypto_secretbox_open_easy(c: Uint8Array, n: Uint8Array, k: Uint8Array): Uint8Array;
	readonly crypto_secretbox_NONCEBYTES: number;
	readonly crypto_secretbox_KEYBYTES: number;
	memzero(b: Uint8Array): void;
}

export interface StashRecord {
	readonly v: 2;
	/** Random id the service worker files the key under. */
	readonly id: string;
	/** Write time (ms). */
	readonly at: number;
	readonly nonce: string;
	readonly ct: string;
}

function b64(u: Uint8Array): string {
	let s = '';
	for (const b of u) s += String.fromCharCode(b);
	return btoa(s);
}
function unb64(s: string): Uint8Array {
	const bin = atob(s);
	const u = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
	return u;
}
function hex(u: Uint8Array): string {
	return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Encrypt `plaintext` under a fresh key. Returns the record to store and
 *  the key to hand to the service worker (the caller zeroes it after). */
export function sealStash(
	sodium: StashSodium,
	plaintext: Uint8Array,
	now: number
): { record: StashRecord; key: Uint8Array } {
	const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	// libsodium accepts only this realm's Uint8Array; bytes from another realm
	// (a TextEncoder of a test DOM) are copied first, and the copy wiped.
	const own = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
	let ct: Uint8Array;
	try {
		ct = sodium.crypto_secretbox_easy(own, nonce, key);
	} finally {
		if (own !== plaintext) own.fill(0);
	}
	return {
		record: { v: 2, id: hex(sodium.randombytes_buf(16)), at: now, nonce: b64(nonce), ct: b64(ct) },
		key
	};
}

/** Parse a stored record; null when it is not a well-formed v2 stash. */
export function parseStashRecord(raw: string): StashRecord | null {
	try {
		const r = JSON.parse(raw) as Partial<StashRecord>;
		if (
			r?.v === 2 &&
			typeof r.id === 'string' &&
			/^[0-9a-f]{32}$/.test(r.id) &&
			typeof r.at === 'number' &&
			Number.isFinite(r.at) &&
			typeof r.nonce === 'string' &&
			typeof r.ct === 'string'
		) {
			return r as StashRecord;
		}
	} catch {
		/* not JSON */
	}
	return null;
}

/** Decrypt a record with its key; null when the key does not open it. */
export function openStash(
	sodium: StashSodium,
	record: StashRecord,
	key: Uint8Array
): Uint8Array | null {
	try {
		return sodium.crypto_secretbox_open_easy(unb64(record.ct), unb64(record.nonce), key);
	} catch {
		return null;
	}
}

/** Service-worker side: the stash keys, in memory only, each handed out at
 *  most once and only while fresh. */
export class ReloadStashKeys {
	readonly #keys = new Map<string, { key: Uint8Array; at: number }>();

	put(id: unknown, key: unknown, now: number): void {
		this.#sweep(now);
		if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return;
		if (Object.prototype.toString.call(key) !== '[object Uint8Array]') return;
		const received = key as Uint8Array;
		if (received.length === 32) this.#keys.set(id, { key: new Uint8Array(received), at: now });
		received.fill(0);
	}

	take(id: unknown, now: number): Uint8Array | null {
		this.#sweep(now);
		if (typeof id !== 'string') return null;
		const e = this.#keys.get(id);
		if (e === undefined) return null;
		this.#keys.delete(id);
		return e.key;
	}

	/** How many keys are held (tests). */
	get size(): number {
		return this.#keys.size;
	}

	#sweep(now: number): void {
		for (const [id, e] of this.#keys) {
			const age = now - e.at;
			if (age < 0 || age > RELOAD_STASH_MAX_AGE_MS) {
				e.key.fill(0);
				this.#keys.delete(id);
			}
		}
	}
}
