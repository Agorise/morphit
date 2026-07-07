/**
 * Morphit ops CLI — `failed-broadcasts` subcommand.
 *
 * Lists every relay drain-queue entry that has had ≥1 broadcast
 * error in the time window.  Used when troubleshooting why the
 * relay isn't getting things out — see the actual error
 * messages chain returned, recent retries, and recipients with
 * persistent issues.
 *
 * Filters:
 *   --since=DUR    Window for the report.  Default 24h.
 */

import type { CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';

interface FailedBroadcast {
	id: string;
	recipient: string;
	kind: string;
	amount_blurt: string;
	reason: string;
	created_at: Date;
	last_error: string | null;
	last_error_at: Date;
	error_count: number;
	broadcast_at: Date | null;
}

const HUMAN_LIMIT = 50;

export async function runFailedBroadcasts(ctx: CommandCtx): Promise<number> {
	const sinceSpec = ctx.flags.since ?? '24h';
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 1h, 24h, 7d');
		return 1;
	}
	const cutoff = new Date(Date.now() - sinceSec * 1000);
	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const result = await ctx.db.query<FailedBroadcast>(
		`SELECT
		   id::text,
		   recipient,
		   kind,
		   amount_blurt::text,
		   reason,
		   created_at,
		   last_error,
		   last_error_at,
		   error_count,
		   broadcast_at
		 FROM relay_pending_transfers
		 WHERE last_error_at IS NOT NULL
		   AND last_error_at >= $1
		 ORDER BY last_error_at DESC
		 LIMIT $2`,
		[cutoff, limit]
	);

	const entries = result.rows;

	if (ctx.flags.json === 'true') {
		emitJson({
			since_sec: sinceSec,
			count: entries.length,
			entries: entries.map((e: FailedBroadcast) => ({
				id: e.id,
				recipient: e.recipient,
				kind: e.kind,
				amount_blurt: e.amount_blurt,
				reason: e.reason,
				created_at: e.created_at.toISOString(),
				last_error: e.last_error,
				last_error_at: e.last_error_at.toISOString(),
				error_count: e.error_count,
				broadcast_at: e.broadcast_at !== null ? e.broadcast_at.toISOString() : null,
				resolved: e.broadcast_at !== null
			}))
		});
		return 0;
	}

	renderHuman(entries, sinceSec);
	return 0;
}

function renderHuman(entries: readonly FailedBroadcast[], sinceSec: number): void {
	section(`Failed broadcasts (last ${formatDuration(sinceSec)})`);

	if (entries.length === 0) {
		info(fmt.green('  No broadcast failures in this window.'));
		return;
	}

	const resolved = entries.filter((e) => e.broadcast_at !== null).length;
	const stuck = entries.length - resolved;
	info(
		`  ${entries.length} entries had errors  ` +
			fmt.dim(`(${resolved} eventually broadcast, ${stuck} still stuck)`)
	);
	blank();

	for (const e of entries) {
		const age = formatDuration(ageSeconds(e.last_error_at));
		const status = e.broadcast_at !== null ? fmt.green('✓') : fmt.red('✗');
		const recipient = e.recipient.length > 18 ? e.recipient.slice(0, 17) + '…' : e.recipient;
		info(
			`  ${status} ${age.padEnd(10)}` +
				`@${recipient.padEnd(20)}` +
				`${e.kind.padEnd(9)}` +
				`${parseFloat(e.amount_blurt).toFixed(2).padEnd(8)}B ` +
				fmt.dim(`(${e.error_count}× errors)`)
		);
		if (e.last_error !== null) {
			const errMsg = e.last_error.length > 100 ? e.last_error.slice(0, 97) + '…' : e.last_error;
			info(`    ${fmt.red(errMsg)}`);
		}
	}
}
