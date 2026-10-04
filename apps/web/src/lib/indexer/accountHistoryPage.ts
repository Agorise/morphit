/**
 * One page of an account's chain history from the indexer, in as many entries
 * as one reply can carry.
 *
 * The indexer answers 413 `reply_too_large` when the page asked for is too
 * large for a reply (a history of long posts, say). It never sends a shorter
 * page instead, because a short page means "start of history" to every
 * caller. So a 413 is read again for the SAME `from` with fewer entries —
 * 1,000, then 100 — and is never taken as the end of the history.
 *
 * It answers 503 `history_busy` with Retry-After when too many history reads
 * are in flight (per client, for all Tor/I2P visitors together, instance-wide):
 * the same page is asked again after that wait, a few times, before the caller
 * gets an error marked `busy`.
 */
import type { AccountHistoryEntry } from '@morphit/indexer-client';

import { fetchAccountHistory } from '$blurt/accountHistory';

/** The page sizes tried after a 413, largest first. */
export const SMALLER_PAGE_LIMITS = [1_000, 100] as const;
/** Reads of one page while the indexer answers `history_busy` (the first one
 *  included): with Retry-After 5 s, about 20 s of waiting before giving up. */
export const BUSY_ATTEMPTS = 5;
/** Wait when Retry-After is missing, and the most it may ask for. */
const DEFAULT_RETRY_MS = 5_000;
const MAX_RETRY_MS = 30_000;

export type AccountHistoryPageResult =
	/** `limit`: the page size that was answered — a page shorter than it is
	 *  the start of history. */
	| {
			readonly kind: 'ok';
			readonly entries: readonly AccountHistoryEntry[];
			readonly limit: number;
	  }
	/** `tooLarge`: still refused at the smallest size. `busy`: the indexer was
	 *  still busy after BUSY_ATTEMPTS reads — try again later. */
	| {
			readonly kind: 'error';
			readonly message: string;
			readonly tooLarge: boolean;
			readonly busy: boolean;
	  };

/** The sizes to try for a request of `limit`, largest first. */
export function pageLimitsFor(limit: number): number[] {
	return [limit, ...SMALLER_PAGE_LIMITS.filter((l) => l < limit)];
}

/** Retry-After (seconds) as a wait in ms, bounded. */
function retryAfterMs(header: string | null): number {
	const secs = header !== null && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) : NaN;
	if (!Number.isFinite(secs)) return DEFAULT_RETRY_MS;
	return Math.min(Math.max(secs * 1_000, 1_000), MAX_RETRY_MS);
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function fetchAccountHistoryPage(
	indexerOrigin: string,
	account: string,
	from: number,
	limit: number,
	fetchImpl: typeof fetch = fetch,
	noCache = false,
	sleep: (ms: number) => Promise<void> = realSleep
): Promise<AccountHistoryPageResult> {
	let message = '';
	for (const l of pageLimitsFor(limit)) {
		let busyTries = 0;
		for (;;) {
			// fetchAccountHistory reports every failure alike; the status (and,
			// for a 503, the error code) tells a too-large page and a busy
			// indexer apart.
			let status = 0;
			let busyWait: number | null = null;
			const tracked = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const res = await fetchImpl(input, init);
				status = res.status;
				if (res.status === 503) {
					const body = (await res
						.clone()
						.json()
						.catch(() => null)) as { code?: unknown } | null;
					if (body?.code === 'history_busy')
						busyWait = retryAfterMs(res.headers.get('retry-after'));
				}
				return res;
			}) as typeof fetch;
			const r = await fetchAccountHistory(indexerOrigin, account, from, l, tracked, noCache);
			if (r.kind === 'ok') return { kind: 'ok', entries: r.entries, limit: l };
			message = r.message;
			if (busyWait !== null) {
				busyTries++;
				if (busyTries >= BUSY_ATTEMPTS)
					return { kind: 'error', message, tooLarge: false, busy: true };
				await sleep(busyWait);
				continue; // the same page, the same size
			}
			if (status === 413) break; // try the next smaller size
			return { kind: 'error', message, tooLarge: false, busy: false };
		}
	}
	return { kind: 'error', message, tooLarge: true, busy: false };
}
