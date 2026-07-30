/**
 * Morphit ops CLI — `loyalty` subcommand.
 *
 * Lists loyalty-milestone delegations triggered in the time
 * window.  Each row pairs an account_loyalty_milestones entry
 * with the relay_pending_transfers that was queued for it.
 *
 * Useful for "did all the recent milestones get delegated?"
 * troubleshooting.
 *
 * Default window is 7 days because milestones are infrequent;
 * a 24h default would usually return zero rows for a small
 * instance.
 *
 * Filters:
 *   --since=DUR    Window for the report.  Default 7d.
 */

import type { CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error } from '../render/term.ts';

interface LoyaltyEntry {
	account: string;
	milestone_blurt: string;
	bp_rewarded: string;
	triggered_in_block: string;
	queued_at: Date | null;
	broadcast_at: Date | null;
	last_error: string | null;
}

const HUMAN_LIMIT = 50;

export async function runLoyalty(ctx: CommandCtx): Promise<number> {
	const sinceSpec = ctx.flags.since ?? '7d';
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 24h, 7d, 30d');
		return 1;
	}
	const cutoff = new Date(Date.now() - sinceSec * 1000);
	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	// Join milestones with their queued/broadcast transfer.  A
	// milestone may not yet have a transfer (race window in the
	// loyalty handler) — LEFT JOIN handles that.
	const result = await ctx.db.query<LoyaltyEntry>(
		`SELECT
		   m.account,
		   m.milestone_blurt::text,
		   m.bp_rewarded::text,
		   m.triggered_in_block::text,
		   t.created_at AS queued_at,
		   t.broadcast_at,
		   t.last_error
		 FROM account_loyalty_milestones m
		 LEFT JOIN relay_pending_transfers t
		   ON t.recipient = m.account
		   AND t.reason = 'loyalty_milestone_' || m.milestone_blurt
		 WHERE COALESCE(t.created_at, NOW()) >= $1
		 ORDER BY COALESCE(t.created_at, NOW()) DESC
		 LIMIT $2`,
		[cutoff, limit]
	);

	const entries = result.rows;

	if (ctx.flags.json === 'true') {
		emitJson({
			since_sec: sinceSec,
			count: entries.length,
			entries: entries.map((e: LoyaltyEntry) => ({
				account: e.account,
				milestone_blurt: e.milestone_blurt,
				bp_rewarded: e.bp_rewarded,
				triggered_in_block: e.triggered_in_block,
				queued_at: e.queued_at !== null ? e.queued_at.toISOString() : null,
				broadcast_at: e.broadcast_at !== null ? e.broadcast_at.toISOString() : null,
				broadcast: e.broadcast_at !== null,
				last_error: e.last_error
			}))
		});
		return 0;
	}

	renderHuman(entries, sinceSec);
	return 0;
}

function renderHuman(entries: readonly LoyaltyEntry[], sinceSec: number): void {
	section(`Loyalty milestones (last ${formatDuration(sinceSec)})`);

	if (entries.length === 0) {
		info(fmt.dim('  No loyalty milestones triggered in this window.'));
		return;
	}

	for (const e of entries) {
		const status =
			e.broadcast_at !== null
				? fmt.green('✓')
				: e.last_error !== null
					? fmt.red('✗')
					: fmt.yellow('⏳');
		const when =
			e.queued_at !== null
				? formatDuration(ageSeconds(e.queued_at)) + ' ago'
				: fmt.dim('not queued');
		info(
			`  ${status} ${when.padEnd(13)}` +
				`@${e.account.padEnd(20)}` +
				`${parseFloat(e.milestone_blurt).toFixed(0).padStart(6)}B paid → ` +
				`${parseFloat(e.bp_rewarded).toFixed(0).padStart(6)} BP delegated` +
				(e.last_error !== null ? `  ${fmt.red(e.last_error.slice(0, 60))}` : '')
		);
	}
}
