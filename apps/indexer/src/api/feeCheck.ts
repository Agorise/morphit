/**
 * Morphit indexer — "check my payment now" for a per-order BTC fee address
 * (v1.20.0, MK-H2 / V3-3).
 *
 *   POST /v1/orders/:account/:permlink/check-fee
 *
 * The background pass looks at a fresh order's address every pass, but a
 * pass runs every 10 minutes. The pay panel's "I've paid — check now" button
 * lands here: the SAME address check the pass runs, for this one order, at
 * most once per order per FEE_CHECK_NOW_COOLDOWN_MS (stamped atomically in
 * the orders row, so it holds across requests and restarts), plus an
 * instance-wide budget so the button cannot be used to hammer the explorers.
 * The per-client HTTP rate limit (the `list` tier) applies on top (main.ts).
 *
 * Anyone may ask: the answer (has this public address been paid) is public
 * chain data, and the request changes nothing but the time of the next look.
 * Nothing is logged about who asked. Response (200):
 *   { fee_status, received_sats, unconfirmed_sats, checked, retry_after_s }
 * `checked: false` — within the cooldown, over the budget, or not an order
 * with an unpaid fee address; the current status is returned either way.
 *
 * (V3-5 / V3-6) Two read routes for cross-checking the numbering:
 *   GET /v1/orders/:account/:permlink/btc-fee
 *       this node's fee address for the order: { index, address, xpub } —
 *       what PEERS ask (public data, already in /v1/orders/:account);
 *   GET /v1/orders/:account/:permlink/btc-fee-crosscheck
 *       asks up to two directory peers the same question (btcFeeCrossCheck)
 *       and answers { verdict: 'agree' | 'disagree' | 'unchecked', asked,
 *       agreeing }. Cached per order for CROSSCHECK_CACHE_MS; at most
 *       CROSSCHECK_GLOBAL_PER_MIN fresh cross-checks per minute instance-wide
 *       (over it: 'unchecked'). The pay panel shows no address on 'disagree'.
 */
import { Hono } from 'hono';

import { errorBody, isAccountName } from '$api/shared';
import type { Database } from '$db/pool';
import { validateOrderPermlink } from '$indexer/permlink';
import { crossCheckBtcFee, type CrossCheckResult } from '$indexer/fee/btcFeeCrossCheck';
import {
	checkFeeAddressNow,
	FEE_CHECK_NOW_COOLDOWN_MS,
	type ExternalFeeRecheckDeps
} from '$indexer/fee/externalFeeRecheck';

/** Instance-wide "check now" lookups per minute (each is one explorer round). */
export const FEE_CHECK_NOW_GLOBAL_PER_MIN = 30;
/** (V3-5) How long a cross-check verdict is reused for the same order. */
export const CROSSCHECK_CACHE_MS = 10 * 60 * 1000;
/** (V3-5) Fresh cross-checks per minute, instance-wide. */
export const CROSSCHECK_GLOBAL_PER_MIN = 20;
const CROSSCHECK_CACHE_MAX = 2000;

export interface FeeCheckRouteDeps {
	readonly db: Database;
	readonly current: () => {
		verifiers: ExternalFeeRecheckDeps['verifiers'];
		amounts: ExternalFeeRecheckDeps['amounts'];
	};
	readonly onChange: (orderId: string) => void;
	readonly clock?: () => number;
	/** (V3-5) Directory peers to ask, best first, and how to GET from one. */
	readonly crossCheck?: {
		readonly peers: () => Promise<readonly { origin: string; hidden: boolean }[]>;
		readonly fetchJson: (url: string, hidden: boolean) => Promise<unknown>;
	};
}

interface FeeRow {
	btc_fee_index: number | null;
	btc_fee_address: string | null;
	btc_fee_xpub: string | null;
}

export function feeCheckRoute(deps: FeeCheckRouteDeps): Hono {
	const app = new Hono();
	const clock = deps.clock ?? (() => Date.now());
	let windowStart = 0;
	let used = 0;

	app.post('/:account/:permlink/check-fee', async (c) => {
		const account = c.req.param('account');
		const permlink = c.req.param('permlink');
		if (!isAccountName(account) || validateOrderPermlink(permlink) !== null) {
			return c.json(errorBody('bad_request', 'invalid account or permlink'), 400);
		}
		const nowMs = clock();
		const status = async () =>
			(
				await deps.db.query<{ fee_status: string; r: string | null; u: string | null }>(
					`SELECT fee_status, btc_fee_received_sats::text AS r, btc_fee_unconfirmed_sats::text AS u
					   FROM orders WHERE account = $1 AND permlink = $2`,
					[account, permlink]
				)
			).rows[0] ?? null;
		const unchanged = async (retryMs: number) => {
			const s = await status();
			if (s === null) return c.json(errorBody('not_found', 'no such order'), 404);
			return c.json({
				fee_status: s.fee_status,
				received_sats: Number(s.r ?? 0),
				unconfirmed_sats: Number(s.u ?? 0),
				checked: false,
				retry_after_s: Math.ceil(retryMs / 1000)
			});
		};
		if (nowMs - windowStart >= 60_000) {
			windowStart = nowMs;
			used = 0;
		}
		if (used >= FEE_CHECK_NOW_GLOBAL_PER_MIN) return unchanged(windowStart + 60_000 - nowMs);
		const { verifiers, amounts } = deps.current();
		const r = await checkFeeAddressNow({
			db: deps.db,
			verifiers,
			amounts,
			now: new Date(nowMs),
			account,
			permlink,
			onChange: deps.onChange
		});
		if (r.kind === 'checked') {
			used++;
			return c.json({
				fee_status: r.fee_status,
				received_sats: r.received_sats,
				unconfirmed_sats: r.unconfirmed_sats,
				checked: true,
				retry_after_s: Math.ceil(FEE_CHECK_NOW_COOLDOWN_MS / 1000)
			});
		}
		return unchanged(r.kind === 'cooldown' ? r.retry_after_ms : FEE_CHECK_NOW_COOLDOWN_MS);
	});

	const local = async (account: string, permlink: string) =>
		(
			await deps.db.query<FeeRow>(
				`SELECT btc_fee_index, btc_fee_address, btc_fee_xpub FROM orders
				  WHERE account = $1 AND permlink = $2`,
				[account, permlink]
			)
		).rows[0] ?? null;

	app.get('/:account/:permlink/btc-fee', async (c) => {
		const account = c.req.param('account');
		const permlink = c.req.param('permlink');
		if (!isAccountName(account) || validateOrderPermlink(permlink) !== null) {
			return c.json(errorBody('bad_request', 'invalid account or permlink'), 400);
		}
		const r = await local(account, permlink);
		if (
			r === null ||
			r.btc_fee_index === null ||
			r.btc_fee_address === null ||
			r.btc_fee_xpub === null
		) {
			return c.json(errorBody('not_found', 'no fee address for this order'), 404);
		}
		return c.json({ index: r.btc_fee_index, address: r.btc_fee_address, xpub: r.btc_fee_xpub });
	});

	const cache = new Map<string, { at: number; result: CrossCheckResult }>();
	let ccWindow = 0;
	let ccUsed = 0;
	app.get('/:account/:permlink/btc-fee-crosscheck', async (c) => {
		const account = c.req.param('account');
		const permlink = c.req.param('permlink');
		if (!isAccountName(account) || validateOrderPermlink(permlink) !== null) {
			return c.json(errorBody('bad_request', 'invalid account or permlink'), 400);
		}
		const r = await local(account, permlink);
		if (
			r === null ||
			r.btc_fee_index === null ||
			r.btc_fee_address === null ||
			r.btc_fee_xpub === null
		) {
			return c.json(errorBody('not_found', 'no fee address for this order'), 404);
		}
		const key = `${account}/${permlink}`;
		const nowMs = clock();
		const hit = cache.get(key);
		if (hit !== undefined && nowMs - hit.at < CROSSCHECK_CACHE_MS) return c.json(hit.result);
		if (nowMs - ccWindow >= 60_000) {
			ccWindow = nowMs;
			ccUsed = 0;
		}
		const unchecked: CrossCheckResult = { verdict: 'unchecked', asked: 0, agreeing: 0 };
		if (deps.crossCheck === undefined || ccUsed >= CROSSCHECK_GLOBAL_PER_MIN)
			return c.json(unchecked);
		ccUsed++;
		let result: CrossCheckResult;
		try {
			result = await crossCheckBtcFee({
				local: { index: r.btc_fee_index, address: r.btc_fee_address, xpub: r.btc_fee_xpub },
				account,
				permlink,
				peers: await deps.crossCheck.peers(),
				fetchJson: deps.crossCheck.fetchJson
			});
		} catch {
			result = unchecked;
		}
		if (cache.size >= CROSSCHECK_CACHE_MAX) cache.clear();
		cache.set(key, { at: nowMs, result });
		return c.json(result);
	});

	return app;
}
