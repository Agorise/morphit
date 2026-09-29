/**
 * v1.20.0 (MK-H2, V3-3 / V3-5) — the pay panel's two questions to its own
 * indexer about an order's BTC fee address (same origin; the page's CSP
 * allows nothing else).
 *
 *   crossCheckFeeAddress — did the other instances this indexer can reach
 *     number the order the same way? 'disagree' means this indexer's view of
 *     the chain differs from theirs: the panel then shows no address.
 *   checkFeeNow — "I've paid, check now": one immediate explorer look,
 *     rate-limited per order by the indexer.
 */
import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';

export type FeeCrossCheck = 'agree' | 'disagree' | 'unchecked';

function orderPath(account: string, permlink: string, tail: string): URL {
	return new URL(
		`/v1/orders/${encodeURIComponent(account)}/${encodeURIComponent(permlink)}/${tail}`,
		resolveOrigin(MORPHIT_INDEXER_ORIGIN)
	);
}

/** Never throws; anything unexpected is 'unchecked' (single-source, as before). */
export async function crossCheckFeeAddress(
	account: string,
	permlink: string
): Promise<FeeCrossCheck> {
	try {
		const res = await fetchWithTimeout(
			orderPath(account, permlink, 'btc-fee-crosscheck'),
			{
				headers: { accept: 'application/json' }
			},
			60_000
		);
		if (!res.ok) return 'unchecked';
		const body = (await res.json()) as { verdict?: unknown };
		return body.verdict === 'agree' || body.verdict === 'disagree' ? body.verdict : 'unchecked';
	} catch {
		return 'unchecked';
	}
}

export interface FeeCheckNow {
	readonly feeStatus: string;
	readonly receivedSats: number;
	readonly unconfirmedSats: number;
	readonly checked: boolean;
	readonly retryAfterS: number;
}

/** Null when the indexer could not be asked. */
export async function checkFeeNow(account: string, permlink: string): Promise<FeeCheckNow | null> {
	try {
		const res = await fetchWithTimeout(
			orderPath(account, permlink, 'check-fee'),
			{
				method: 'POST',
				headers: { accept: 'application/json' }
			},
			60_000
		);
		if (!res.ok) return null;
		const b = (await res.json()) as Record<string, unknown>;
		const n = (v: unknown): number =>
			typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
		return {
			feeStatus: typeof b.fee_status === 'string' ? b.fee_status : 'awaiting_payment',
			receivedSats: n(b.received_sats),
			unconfirmedSats: n(b.unconfirmed_sats),
			checked: b.checked === true,
			retryAfterS: Math.max(1, Math.ceil(n(b.retry_after_s)))
		};
	} catch {
		return null;
	}
}
