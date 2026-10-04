/**
 * Was a treasury BTC key (`treasury.btc.xpub`) really pinned by @morphit?
 *
 * After a key rotation, an order posted under the previous key keeps its fee
 * address from THAT key (the indexer numbers it under the pin in force at its
 * block). The browser shows such an address only if it can derive it itself
 * from a key @morphit really pinned. The latest release (the release store)
 * only has the new key, so the older one is answered from releases THIS
 * browser already verified: every release the release check proves
 * ($net/releaseFetch — signature recovered to the pinned @morphit key) has its
 * BTC key remembered here (`rememberPinnedBtcXpub`). No extra request is ever
 * made for it, so the release check's budget holds.
 *
 * The usual case is covered: whoever posted an order under the old key had
 * the old key verified by their browser when they posted. A browser that never
 * saw a release carrying that key keeps the address hidden — never shown
 * unchecked.
 */
import { parseAccountXpub } from '@morphit/release-schema';

export const BTC_KEY_CACHE_KEY = 'morphit.releaseCheck.v2.btcKeys';
/** How long a verified key is remembered: longer than any order waits for
 *  its listing fee. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

type Remembered = Record<string, { readonly at: number; readonly pinned: true }>;

function localStore(): StorageLike | null {
	try {
		return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
	} catch {
		return null;
	}
}

function readAll(storage: StorageLike, now: number): Remembered {
	try {
		const raw = storage.getItem(BTC_KEY_CACHE_KEY);
		if (raw === null) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== 'object') return {};
		const out: Record<string, { at: number; pinned: true }> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			const e = v as { at?: unknown; pinned?: unknown };
			// Only keys learned from verified releases count (older builds also
			// stored refusals here).
			if (typeof e?.at !== 'number' || e.pinned !== true) continue;
			if (now - e.at < 0 || now - e.at >= KEEP_MS) continue;
			if (!parseAccountXpub(k).ok) continue;
			out[k] = { at: e.at, pinned: true };
		}
		return out;
	} catch {
		return {};
	}
}

/** Remember the BTC key of a release the release check just VERIFIED. Call
 *  with nothing else. */
export function rememberPinnedBtcXpub(xpub: unknown): void {
	if (typeof xpub !== 'string') return;
	const parsed = parseAccountXpub(xpub);
	if (!parsed.ok) return;
	const storage = localStore();
	if (storage === null) return;
	const now = Date.now();
	try {
		storage.setItem(
			BTC_KEY_CACHE_KEY,
			JSON.stringify({ ...readAll(storage, now), [parsed.value.xpub]: { at: now, pinned: true } })
		);
	} catch {
		/* private mode / quota: nothing remembered */
	}
}

/** True only when `xpub` is the BTC key of a release this browser verified.
 *  False otherwise (the address then stays hidden — never shown unchecked). */
export function verifyPinnedBtcXpub(xpub: string): Promise<boolean> {
	const parsed = parseAccountXpub(xpub);
	if (!parsed.ok) return Promise.resolve(false);
	const storage = localStore();
	if (storage === null) return Promise.resolve(false);
	return Promise.resolve(readAll(storage, Date.now())[parsed.value.xpub] !== undefined);
}
