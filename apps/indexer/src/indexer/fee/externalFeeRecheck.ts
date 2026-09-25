/**
 * External (BTC/XMR) listing-fee re-check (v1.18.0 deep-deep, H1).
 *
 * What was wrong: a BTC/XMR order was verified exactly once, when its order op
 * was indexed. If the explorers were unreachable (or disagreed) it landed as
 * `pending_external` and NOTHING ever looked at it again — the only way out was
 * the attestation path, which the red team showed could be satisfied by the
 * poster plus one sock for a txid that does not exist. Legitimate payers whose
 * explorers were briefly down were stranded the same way.
 *
 * This job periodically re-runs the SAME verifier the order handler uses on:
 *   - live `pending_external` orders,
 *   - live `verified_by_attestation` orders (attestation is only the fallback
 *     for "the explorers could not answer" — once they can, their answer wins),
 *   - live `missing` orders less than MISSING_RECHECK_HOURS old (a txid that a
 *     quorum of explorers 404'd at intake, e.g. a payment still propagating).
 *
 * The verdict is a pure function of (explorer answer, chain-derived rows):
 *
 *   explorer verified            → 'verified'
 *   explorer underpaid           → 'underpaid'
 *   explorer rejected otherwise  → 'missing'   (e.g. a quorum answered 404)
 *   explorer has no answer       → attestation quorum met  ? 'verified_by_attestation'
 *                                                          : 'pending_external'
 *                                  (a 'missing' row with no answer stays 'missing')
 *
 * so every instance re-checking the same order from the same chain data and the
 * same explorer answers reaches the same status. The attestation quorum is the
 * shared $indexer/fee/attestationQuorum rule, so rows promoted under the old
 * "poster counts" rule are re-derived under the current one.
 *
 * Only `fee_status` (and `updated_at`, so the orderbook-stream fallback poll
 * sees the flip) changes; the order row itself is untouched. `reused` rows are
 * never touched (they carry no external_tx_id).
 */

import type { Database } from '$db/pool';
import type { FeeVerifier } from '$indexer/fee/verifier';
import { attestationQuorumMet } from '$indexer/fee/attestationQuorum';
import { logger } from '$log';

const log = logger('fee-recheck');

/** How long after posting a `missing` BTC/XMR order is still re-checked. */
export const MISSING_RECHECK_HOURS = 24;
/** Default upper bound on verifier calls per run (explorer rate limits). */
export const DEFAULT_RECHECK_BATCH = 25;
/** How often the poller runs a re-check pass. */
export const RECHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Minimum spacing between two re-checks of the same order. */
export const PER_ORDER_MIN_SPACING_MS = 30 * 60 * 1000;

export interface ExternalFeeRecheckDeps {
	readonly db: Database;
	readonly verifiers: { readonly btc?: FeeVerifier; readonly xmr?: FeeVerifier };
	readonly amounts: { readonly btcSatoshis?: number; readonly xmrPiconero?: bigint };
	/** Reference time for the `missing` window. */
	readonly now: Date;
	/** Max verifier calls this run. */
	readonly limit?: number;
	/** Return true to skip an order this run (per-order spacing). */
	readonly skip?: (orderId: string) => boolean;
	/** Called for every order whose fee_status changed. */
	readonly onChange?: (orderId: string) => void;
	/** Called for every order actually checked (for spacing bookkeeping). */
	readonly onChecked?: (orderId: string) => void;
}

interface Candidate {
	account: string;
	permlink: string;
	fee_status: string;
	fee_method: 'btc' | 'xmr';
	external_tx_id: string;
	tx_proof: string | null;
}

type Next = 'verified' | 'underpaid' | 'missing' | 'verified_by_attestation' | 'pending_external';

/** One re-check pass. Never throws for a single order's failure. */
export async function recheckExternalFees(
	deps: ExternalFeeRecheckDeps
): Promise<{ checked: number; changed: number }> {
	const limit = deps.limit ?? DEFAULT_RECHECK_BATCH;
	const missingCutoff = new Date(deps.now.getTime() - MISSING_RECHECK_HOURS * 3600 * 1000);
	const res = await deps.db.query<Candidate>(
		`SELECT account, permlink, fee_status, fee_method, external_tx_id, tx_proof
		   FROM orders
		  WHERE status = 'live'
		    AND fee_method IN ('btc', 'xmr')
		    AND external_tx_id IS NOT NULL
		    AND (fee_status IN ('pending_external', 'verified_by_attestation')
		         OR (fee_status = 'missing' AND created_at >= $1))
		  ORDER BY created_at ASC, account ASC, permlink ASC
		  LIMIT 1000`,
		[missingCutoff]
	);

	let checked = 0;
	let changed = 0;
	for (const row of res.rows) {
		if (checked >= limit) break;
		const orderId = `${row.account}/${row.permlink}`;
		if (deps.skip?.(orderId)) continue;
		const verifier = row.fee_method === 'btc' ? deps.verifiers.btc : deps.verifiers.xmr;
		const expected = row.fee_method === 'btc' ? deps.amounts.btcSatoshis : deps.amounts.xmrPiconero;
		// Method no longer configured here: nothing to ask, leave the row as is.
		if (verifier === undefined || expected === undefined || expected === 0 || expected === 0n) {
			continue;
		}
		checked++;
		deps.onChecked?.(orderId);
		try {
			const result = await verifier.verify({
				feeMethod: row.fee_method,
				expectedAmount: expected,
				externalTxId: row.external_tx_id,
				txProof: row.tx_proof,
				permlink: row.permlink,
				signer: row.account
			});
			let next: Next;
			if (result.kind === 'verified') {
				next = 'verified';
			} else if (result.kind === 'rejected') {
				// Same mapping as the order handler at intake.
				next = result.reason.startsWith('underpaid') ? 'underpaid' : 'missing';
			} else if (row.fee_status === 'missing') {
				// No answer now does not overturn an earlier definitive "not found".
				continue;
			} else {
				next = (await attestationQuorumMet(deps.db, row.account, row.permlink))
					? 'verified_by_attestation'
					: 'pending_external';
			}
			if (next === row.fee_status) continue;
			const upd = await deps.db.query(
				`UPDATE orders SET fee_status = $3, updated_at = NOW()
				  WHERE account = $1 AND permlink = $2 AND fee_status = $4 AND status = 'live'`,
				[row.account, row.permlink, next, row.fee_status]
			);
			if ((upd.rowCount ?? 0) > 0) {
				changed++;
				log.info('fee_status_rechecked', {
					order: orderId,
					from: row.fee_status,
					to: next,
					reason: result.kind === 'verified' ? 'explorer_verified' : result.reason
				});
				deps.onChange?.(orderId);
			}
		} catch (err) {
			log.warn('fee_recheck_failed', { order: orderId }, err);
		}
	}
	return { checked, changed };
}

/** Self-throttling wrapper the poller calls every tick. */
export class ExternalFeeRechecker {
	private lastRunAt = 0;
	private inFlight = false;
	private readonly lastChecked = new Map<string, number>();

	constructor(
		private readonly db: Database,
		private readonly current: () => {
			verifiers: ExternalFeeRecheckDeps['verifiers'];
			amounts: ExternalFeeRecheckDeps['amounts'];
		},
		private readonly onChange: (orderId: string) => void,
		private readonly clock: () => number = () => Date.now()
	) {}

	async maybeRun(): Promise<void> {
		const now = this.clock();
		if (this.inFlight || now - this.lastRunAt < RECHECK_INTERVAL_MS) return;
		this.lastRunAt = now;
		this.inFlight = true;
		try {
			const { verifiers, amounts } = this.current();
			if (verifiers.btc === undefined && verifiers.xmr === undefined) return;
			// Forget spacing entries old enough not to matter (bounded map).
			for (const [k, t] of this.lastChecked) {
				if (now - t >= PER_ORDER_MIN_SPACING_MS) this.lastChecked.delete(k);
			}
			await recheckExternalFees({
				db: this.db,
				verifiers,
				amounts,
				now: new Date(now),
				skip: (id) => {
					const t = this.lastChecked.get(id);
					return t !== undefined && now - t < PER_ORDER_MIN_SPACING_MS;
				},
				onChecked: (id) => this.lastChecked.set(id, now),
				onChange: this.onChange
			});
		} catch (err) {
			log.warn('fee_recheck_pass_failed', {}, err);
		} finally {
			this.inFlight = false;
		}
	}
}
