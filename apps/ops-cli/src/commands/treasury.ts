/**
 * Morphit ops CLI — `treasury btc` (v1.20.0, MK-H2). READ-ONLY.
 *
 *   sudo morphit-ops treasury btc [--addresses] [--json]
 *
 * Run on the SERVER (it reads this node's indexer database).
 *
 * Since the release op pins the treasury's BTC account xpub, every BTC-fee
 * order pays its OWN receive address n of that key. The treasury wallet
 * (Sparrow / Electrum / Bitcoin Core, holding the same xpub) sees those
 * payments only if it scans far enough: it stops after "gap limit" unused
 * addresses in a row, and orders that are never paid leave unused addresses.
 * This command prints the key in the forms each wallet takes, the highest
 * address index handed out, the longest run of unused addresses, and the gap
 * limit to set — and, with --addresses, the whole list.
 *
 * "Paid" is what THIS node's explorers saw (orders.btc_fee_received_sats /
 * fee_status). An address this node never saw paid is counted as unused,
 * which can only make the recommended gap limit larger, never too small.
 */
import { deriveBtcFeeAddress, parseAccountXpub } from '@morphit/release-schema';

import type { CommandCtx } from '../lib/ctx.ts';
import { emitJson } from '../render/json.ts';
import { info, section, blank, warn } from '../render/term.ts';

export interface BtcAllocation {
	readonly idx: number;
	readonly account: string;
	readonly permlink: string;
	/** orders.fee_status, or null when this node has no order row for it
	 *  (an op the order validator or this node's settings refused). */
	readonly fee_status: string | null;
	readonly received_sats: number;
	readonly unconfirmed_sats: number;
}

export interface BtcTreasuryReport {
	readonly xpub: string;
	readonly zpub: string;
	readonly keyId: string;
	readonly pinnedInBlock: number;
	readonly handedOut: number;
	readonly highestIndex: number | null;
	readonly paid: number;
	readonly awaiting: number;
	readonly refused: number;
	/** Longest run of unused addresses BELOW a used one (from index 0). */
	readonly longestUnusedRun: number;
	/** Unused addresses above the highest used one (orders not paid yet). */
	readonly unusedAboveLastPaid: number;
	readonly recommendedGapLimit: number;
	readonly allocations: readonly (BtcAllocation & {
		readonly address: string;
		readonly used: boolean;
	})[];
}

const WALLET_DEFAULT_GAP = 20;

/** Pure: turn the allocation list into the report. */
export function buildBtcTreasuryReport(
	pin: { xpub: string; pinnedInBlock: number },
	allocations: readonly BtcAllocation[],
	refused: number
): BtcTreasuryReport {
	const parsed = parseAccountXpub(pin.xpub);
	if (!parsed.ok) throw new Error(`the pinned treasury key does not parse (${parsed.reason})`);
	const acct = parsed.value;
	const sorted = [...allocations].sort((a, b) => a.idx - b.idx);
	const rows = sorted.map((a) => ({
		...a,
		address: deriveBtcFeeAddress(acct, a.idx),
		used: a.received_sats > 0 || a.unconfirmed_sats > 0 || a.fee_status === 'verified'
	}));
	let longest = 0;
	let prev = -1;
	for (const r of rows) {
		if (!r.used) continue;
		longest = Math.max(longest, r.idx - prev - 1);
		prev = r.idx;
	}
	const highest = rows.length > 0 ? rows[rows.length - 1]!.idx : null;
	const above = highest === null ? 0 : highest - prev;
	const needed = Math.max(longest, above) + 1;
	// Headroom for orders posted after this report, rounded to a tidy number.
	const recommended = Math.max(WALLET_DEFAULT_GAP, Math.ceil((needed + 10) / 10) * 10);
	return {
		xpub: acct.xpub,
		zpub: acct.zpub,
		keyId: acct.keyId,
		pinnedInBlock: pin.pinnedInBlock,
		handedOut: rows.length,
		highestIndex: highest,
		paid: rows.filter((r) => r.fee_status === 'verified').length,
		awaiting: rows.filter((r) => r.fee_status === 'awaiting_payment').length,
		refused,
		longestUnusedRun: longest,
		unusedAboveLastPaid: above,
		recommendedGapLimit: recommended,
		allocations: rows
	};
}

/** Pure: the human-readable lines. */
export function formatBtcTreasuryReport(r: BtcTreasuryReport, withAddresses: boolean): string[] {
	const out: string[] = [];
	const gap = r.recommendedGapLimit;
	out.push(`Treasury key id       ${r.keyId}   (pinned on chain in block ${r.pinnedInBlock})`);
	out.push(
		`Addresses handed out  ${r.handedOut}${r.highestIndex !== null ? `   (index 0 … ${r.highestIndex})` : ''}`
	);
	out.push(`  paid                ${r.paid}`);
	out.push(`  waiting for payment ${r.awaiting}`);
	out.push(`  refused (no address) ${r.refused}`);
	out.push(`Longest run of unused addresses before a paid one: ${r.longestUnusedRun}`);
	out.push(`Unused addresses above the last paid one:          ${r.unusedAboveLastPaid}`);
	out.push('');
	out.push(`SET YOUR WALLET'S GAP LIMIT TO AT LEAST ${gap}`);
	out.push(
		'  Sparrow (on your laptop): open the treasury wallet → Settings → Advanced → Gap limit'
	);
	out.push(
		`  Electrum: View → Console, then type in the Console tab: wallet.change_gap_limit(${gap})`
	);
	out.push('  Bitcoin Core: see the descriptor below; import it with');
	out.push(`    "range": [0, ${(r.highestIndex ?? 0) + gap}]`);
	out.push('');
	out.push('The same key, for a watch-only wallet:');
	out.push(`  zpub (Sparrow / Electrum)  ${r.zpub}`);
	out.push(`  descriptor (Bitcoin Core)  wpkh(${r.xpub}/0/*)`);
	out.push('    (run  getdescriptorinfo "wpkh(…/0/*)"  in Core to get its #checksum)');
	if (withAddresses) {
		out.push('');
		out.push(
			'index  address                                     status              received (sats)  order'
		);
		for (const a of r.allocations) {
			const status = a.fee_status ?? 'no order on this node';
			out.push(
				`${String(a.idx).padStart(5)}  ${a.address.padEnd(42)}  ${status.padEnd(18)}  ${String(a.received_sats).padStart(15)}  @${a.account}/${a.permlink}`
			);
		}
	} else if (r.handedOut > 0) {
		out.push('');
		out.push('Add --addresses to list every address with its order and status.');
	}
	return out;
}

interface PinRow {
	xpub: string;
	first_block: string;
}

async function loadAllocations(
	ctx: CommandCtx,
	xpub: string
): Promise<{ allocs: BtcAllocation[]; refused: number }> {
	const fromLog = await ctx.db.query<{
		idx: number;
		account: string;
		permlink: string;
		fee_status: string | null;
		received_sats: string;
		unconfirmed_sats: string;
	}>(
		`SELECT l.idx, l.account, l.permlink, o.fee_status,
		        COALESCE(o.btc_fee_received_sats, 0)::text AS received_sats,
		        COALESCE(o.btc_fee_unconfirmed_sats, 0)::text AS unconfirmed_sats
		   FROM btc_fee_address_log l
		   LEFT JOIN orders o
		     ON o.account = l.account AND o.permlink = l.permlink AND o.btc_fee_xpub = l.xpub
		  WHERE l.xpub = $1 AND l.idx IS NOT NULL
		  ORDER BY l.idx`,
		[xpub]
	);
	// The log is a rebuildable cache; the orders rows are the fallback so a
	// truncated log never hides an address that was handed out.
	const fromOrders = await ctx.db.query<{
		idx: number;
		account: string;
		permlink: string;
		fee_status: string;
		received_sats: string;
		unconfirmed_sats: string;
	}>(
		`SELECT o.btc_fee_index AS idx, o.account, o.permlink, o.fee_status,
		        COALESCE(o.btc_fee_received_sats, 0)::text AS received_sats,
		        COALESCE(o.btc_fee_unconfirmed_sats, 0)::text AS unconfirmed_sats
		   FROM orders o
		  WHERE o.btc_fee_xpub = $1 AND o.btc_fee_index IS NOT NULL`,
		[xpub]
	);
	const byIdx = new Map<number, BtcAllocation>();
	for (const r of [...fromLog.rows, ...fromOrders.rows]) {
		const idx = Number(r.idx);
		const prior = byIdx.get(idx);
		if (prior !== undefined && prior.fee_status !== null) continue;
		byIdx.set(idx, {
			idx,
			account: r.account,
			permlink: r.permlink,
			fee_status: r.fee_status,
			received_sats: Number(r.received_sats),
			unconfirmed_sats: Number(r.unconfirmed_sats)
		});
	}
	const refused = await ctx.db.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n FROM btc_fee_address_log l WHERE l.xpub = $1 AND l.idx IS NULL`,
		[xpub]
	);
	return { allocs: [...byIdx.values()], refused: Number(refused.rows[0]?.n ?? '0') };
}

/** Every treasury xpub ever pinned, oldest first, with its first block. */
export async function loadBtcTreasuryReports(ctx: CommandCtx): Promise<BtcTreasuryReport[]> {
	const pins = await ctx.db.query<PinRow>(
		`SELECT r.treasury->'btc'->>'xpub' AS xpub, MIN(r.source_block_num)::text AS first_block
		   FROM releases r
		  WHERE r.valid = true AND r.treasury->'btc'->>'xpub' IS NOT NULL
		  GROUP BY 1
		  ORDER BY 2`
	);
	const reports: BtcTreasuryReport[] = [];
	for (const p of pins.rows) {
		const { allocs, refused } = await loadAllocations(ctx, p.xpub);
		reports.push(
			buildBtcTreasuryReport(
				{ xpub: p.xpub, pinnedInBlock: Number(p.first_block) },
				allocs,
				refused
			)
		);
	}
	return reports;
}

export async function runTreasury(ctx: CommandCtx): Promise<number> {
	const what = ctx.positional[0];
	if (what !== 'btc') {
		info('Usage: sudo morphit-ops treasury btc [--addresses] [--json]   (run on the server)');
		return 1;
	}
	const reports = await loadBtcTreasuryReports(ctx);
	const withAddresses = ctx.flags.addresses === 'true';
	if (ctx.flags.json === 'true') {
		emitJson({
			keys: reports.map((r) => ({
				...r,
				allocations: withAddresses ? r.allocations : undefined
			}))
		});
		return 0;
	}
	section('BTC treasury — per-order fee addresses (read-only)');
	if (reports.length === 0) {
		info('No release op has pinned a treasury BTC xpub yet, so BTC fees still go to the');
		info('single shared address. Nothing to set in your wallet.');
		return 0;
	}
	reports.forEach((r, i) => {
		if (i > 0) blank();
		if (reports.length > 1) {
			info(
				i === reports.length - 1
					? 'Key in use now:'
					: 'Earlier key (still receives payments for its orders):'
			);
		}
		for (const line of formatBtcTreasuryReport(r, withAddresses)) info(line);
	});
	if (reports.length > 1) {
		blank();
		warn('More than one treasury key has been pinned: keep a watch-only wallet for EACH.');
	}
	return 0;
}
