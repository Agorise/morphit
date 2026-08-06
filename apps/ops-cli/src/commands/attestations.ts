/**
 * Morphit ops CLI — `attestations` subcommand.
 *
 * Lists orders awaiting fee-attestation verification.  These
 * are orders posted with an external-chain fee path (BTC or
 * XMR) where the attestor swarm hasn't yet confirmed enough
 * observations.
 *
 * Each order is shown with the count of attestations landed so
 * far, sorted by oldest-first (orders waiting longest first).
 */

import type { CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt } from '../render/term.ts';

interface PendingOrder {
	account: string;
	permlink: string;
	asset: string;
	side: string;
	created_at: Date;
	fee_method: string;
	external_tx_id: string | null;
	attestations_count: string;
}

const HUMAN_LIMIT = 50;

export async function runAttestations(ctx: CommandCtx): Promise<number> {
	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const result = await ctx.db.query<PendingOrder>(
		`SELECT
		   o.account,
		   o.permlink,
		   o.asset,
		   o.side,
		   o.created_at,
		   o.fee_method,
		   o.external_tx_id,
		   COALESCE(
		     (SELECT COUNT(*)::text
		        FROM fee_attestations a
		       WHERE a.order_account  = o.account
		         AND a.order_permlink = o.permlink),
		     '0'
		   ) AS attestations_count
		 FROM orders o
		 WHERE o.fee_status = 'pending_external'
		   AND o.status = 'live'
		 ORDER BY o.created_at ASC
		 LIMIT $1`,
		[limit]
	);

	const orders = result.rows;

	if (ctx.flags.json === 'true') {
		emitJson({
			count: orders.length,
			orders: orders.map((o: PendingOrder) => ({
				account: o.account,
				permlink: o.permlink,
				asset: o.asset,
				side: o.side,
				created_at: o.created_at.toISOString(),
				fee_method: o.fee_method,
				external_tx_id: o.external_tx_id,
				attestations: parseInt(o.attestations_count, 10),
				age_sec: ageSeconds(o.created_at)
			}))
		});
		return 0;
	}

	renderHuman(orders);
	return 0;
}

function renderHuman(orders: readonly PendingOrder[]): void {
	section('Orders awaiting fee-attestation verification');

	if (orders.length === 0) {
		info(fmt.green('  No orders awaiting attestation — external-chain fee path is healthy.'));
		return;
	}

	info(
		fmt.dim(
			'  ' + 'AGE'.padEnd(10) + 'ACCOUNT/PERMLINK'.padEnd(40) + 'ASSET'.padEnd(7) + 'ATTESTATIONS'
		)
	);

	for (const o of orders) {
		const age = formatDuration(ageSeconds(o.created_at));
		const acctPerm = `@${o.account}/${o.permlink}`;
		const acctPermTrunc = acctPerm.length > 38 ? acctPerm.slice(0, 37) + '…' : acctPerm;
		const count = parseInt(o.attestations_count, 10);
		const countStr =
			count === 0
				? fmt.red(`${count} (no attestor has observed yet)`)
				: count < 2
					? fmt.yellow(`${count} (need more)`)
					: fmt.green(`${count}`);
		info('  ' + age.padEnd(10) + acctPermTrunc.padEnd(40) + o.asset.padEnd(7) + countStr);
	}
}
