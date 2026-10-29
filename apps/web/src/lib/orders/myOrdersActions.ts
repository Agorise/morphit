/**
 * Pure rules behind the /my/orders page: when the page may complete an order
 * on its own, which deep-link hash it acts on, and how a re-read of the newest
 * page merges into the orders already shown.
 */

import type { OrderRecord } from '@morphit/indexer-client';
import type { TradeState } from '$lib/trades/tradeStatusPure';

/** The counterparty to name when /my/orders may broadcast
 *  `morphit_order_complete_v1` for this order by itself, or null when it must
 *  not (the seller uses "Mark as complete" instead).
 *
 *  Only a live order whose payment this client verified against the amount
 *  the seller asked for, from the counterparty the seller is trading with. */
export function autoCompleteCounterparty(
	order: Pick<OrderRecord, 'status'>,
	st: TradeState | undefined
): string | null {
	if (order.status !== 'live' || st === undefined) return null;
	// `released` / `completed` count as paid on the page, but they are not a
	// verification by themselves, so they never complete an order here.
	if (st.phase !== 'paid_verified') return null;
	// Checked against the buyer's own figure only ("a payment arrived"): the
	// seller confirms by hand.
	if (st.amountConfirmed !== true) return null;
	if (st.engagedPeer === undefined || st.engagedPeer === '' || st.peer !== st.engagedPeer) {
		return null;
	}
	return st.engagedPeer;
}

/** What a /my/orders URL hash asks for. */
export type MyOrdersHashAction =
	| { readonly kind: 'order'; readonly permlink: string }
	| { readonly kind: 'feedback'; readonly permlink: string }
	| { readonly kind: 'feature'; readonly permlink: string }
	| { readonly kind: 'cancel'; readonly permlink: string };

const HASH_RE = /^#(?:(order)-|(feedback|feature|cancel)=)([A-Za-z0-9-]+)$/;

/** Parse `#order-<permlink>`, `#feedback=<permlink>`, `#feature=<permlink>`
 *  or `#cancel=<permlink>` (the forms the outbid push, the feedback reminder
 *  and the paired-phone hand-off emit). Anything else is null. */
export function parseMyOrdersHash(hash: string): MyOrdersHashAction | null {
	let h = hash;
	try {
		h = decodeURIComponent(hash);
	} catch {
		return null;
	}
	const m = HASH_RE.exec(h);
	if (!m) return null;
	const kind = (m[1] ?? m[2]) as MyOrdersHashAction['kind'];
	return { kind, permlink: m[3]! };
}

/** Whether an order's Feature form can be opened: the order is live, not a
 *  finished trade, and its listing fee is verified (a feature bid needs all
 *  three; the row shows the Feature button under exactly these). */
export function featureFormOpenable(
	o: { readonly fee_status?: string | null },
	live: boolean,
	paid: boolean
): boolean {
	return (
		live && !paid && (o.fee_status === 'verified' || o.fee_status === 'verified_by_attestation')
	);
}

/** How long /my/orders?featuring=<permlink> keeps waiting for the just-posted
 *  order to become featurable. A BLURT-fee order is durable within about a
 *  minute; a BTC fee is verified at its first confirmation (often 10–30 min)
 *  and an XMR fee later still, so the wait covers those (v1.21.17 review). */
export const FEATURING_WAIT_MS = 3 * 60 * 60_000;
/** Read every 10 s for the first minutes (a BLURT fee), then every minute. */
export const FEATURING_FAST_FOR_MS = 5 * 60_000;

/** When to read the orders again, `elapsedMs` after the page opened with
 *  ?featuring=, or null to stop waiting. */
export function featuringNextPollMs(elapsedMs: number): number | null {
	if (elapsedMs >= FEATURING_WAIT_MS) return null;
	return elapsedMs < FEATURING_FAST_FOR_MS ? 10_000 : 60_000;
}

/** Merge a fresh read of the NEWEST page into the orders already loaded:
 *  rows in the page replace their older copies, rows only in `existing`
 *  (older pages) stay. Ordered newest-updated first, as the indexer pages. */
export function mergeNewestPage(
	existing: readonly OrderRecord[],
	page: readonly OrderRecord[]
): OrderRecord[] {
	const fresh = new Set(page.map((o) => o.permlink));
	const out = [...page, ...existing.filter((o) => !fresh.has(o.permlink))];
	out.sort((a, b) => {
		const d = Date.parse(b.updated_at) - Date.parse(a.updated_at);
		if (d !== 0 && Number.isFinite(d)) return d;
		return a.permlink < b.permlink ? -1 : a.permlink > b.permlink ? 1 : 0;
	});
	return out;
}

/** The orders /my/orders counts as "Paid": its Paid filter, and Feature /
 *  Cancel and the "Visible in orderbook" pill hidden.
 *
 *  A released or completed trade, or a payment verified against the amount
 *  the seller asked for. A payment checked only against the buyer's own
 *  figure (no amount was asked: the chat says "Received … (no amount was
 *  asked)") is not Paid: the seller still decides, so the order keeps its
 *  Feature / Cancel actions. */
export function paidPermlinksOf(
	states: ReadonlyMap<string, TradeState>,
	/** The account whose orders the page lists: only trades on ITS orders. */
	orderOwner: string
): Set<string> {
	const paid = new Set<string>();
	for (const st of states.values()) {
		if (st.orderOwner !== orderOwner) continue;
		if (
			st.phase === 'released' ||
			st.phase === 'completed' ||
			(st.phase === 'paid_verified' && st.amountConfirmed === true)
		) {
			paid.add(st.orderPermlink);
		}
	}
	return paid;
}
