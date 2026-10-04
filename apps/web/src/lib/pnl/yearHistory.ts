/**
 * The last 365 days of an account's chain history, for the yearly P&L export
 * (MyBalanceCard), read page by page from the indexer.
 *
 * Pages are read backward from the newest entry until one reaches an entry
 * older than a year, or the start of history (a page shorter than the size
 * that was answered). A page too large for one reply is read again with fewer
 * entries, and a busy indexer is waited out a few times
 * ($lib/indexer/accountHistoryPage); the following pages start at
 * the size that worked (each refusal costs the indexer a full node read). Any failed read fails the export,
 * and so does more activity than MAX_ENTRIES in a year: an export that
 * quietly stopped short would under-report the year.
 */
import type { AccountHistoryEntry } from '@morphit/indexer-client';

import { fetchAccountHistoryPage } from '$lib/indexer/accountHistoryPage';
import type { HistoryOp } from './categorize';

/** Entries asked for per page (the chain's maximum). */
export const PAGE_LIMIT = 10_000;
/** The most history entries the export reads. */
export const MAX_ENTRIES = 50_000;

export type YearHistoryResult =
	| { readonly kind: 'ok'; readonly ops: HistoryOp[] }
	| { readonly kind: 'error'; readonly reason: 'fetch_failed' | 'busy' | 'too_much_history' };

export async function fetchYearOfHistory(
	origin: string,
	account: string,
	nowMs: number = Date.now(),
	fetchImpl: typeof fetch = fetch,
	sleep?: (ms: number) => Promise<void>
): Promise<YearHistoryResult> {
	const oneYearAgoSec = Math.floor(nowMs / 1000) - 365 * 86_400;
	const collected: HistoryOp[] = [];
	let read = 0;
	// −1: the newest page; then the entry before the oldest one seen.
	let from = -1;
	let limit: number = PAGE_LIMIT;
	for (;;) {
		const r = await fetchAccountHistoryPage(origin, account, from, limit, fetchImpl, false, sleep);
		if (r.kind !== 'ok') return { kind: 'error', reason: r.busy ? 'busy' : 'fetch_failed' };
		const history: readonly AccountHistoryEntry[] = r.entries;
		if (history.length === 0) break;
		read += history.length;

		let oldestSeen = Number.POSITIVE_INFINITY;
		let reachedYearOld = false;
		for (const entry of history) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const seq = entry[0];
			const op = entry[1] as unknown as HistoryOp;
			if (typeof seq !== 'number') continue;
			oldestSeen = Math.min(oldestSeen, seq);
			const ts = Date.parse(op.timestamp + (op.timestamp.endsWith('Z') ? '' : 'Z')) / 1000;
			if (Number.isFinite(ts) && ts < oneYearAgoSec) reachedYearOld = true;
			collected.push(op);
		}
		if (reachedYearOld || history.length < r.limit || oldestSeen <= 0) break;
		if (read >= MAX_ENTRIES) return { kind: 'error', reason: 'too_much_history' };
		from = oldestSeen - 1;
		limit = r.limit;
	}
	return { kind: 'ok', ops: collected };
}
