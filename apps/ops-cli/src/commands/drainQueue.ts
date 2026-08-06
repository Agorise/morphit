/**
 * Morphit ops CLI — `drain-queue` subcommand.
 *
 * Lists pending entries in the relay's drain queue.  Sorted
 * oldest-first (FIFO order, matches the relay's drain order).
 *
 * Filters:
 *   --age=DUR    Show only entries older than DUR.  Use to
 *                triage "what's been stuck a while?"  Examples:
 *                  --age=5m   show entries waiting >5 minutes
 *                  --age=1h   show entries waiting >1 hour
 *
 * Output:
 *   - default:   human-readable table, max 50 rows
 *   - --json:    array of all matching entries
 */

import type { CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';

interface DrainEntry {
	readonly id: string;
	readonly recipient: string;
	readonly kind: 'liquid' | 'vesting';
	readonly amount_blurt: string;
	readonly reason: string;
	readonly created_at: Date;
	readonly last_error: string | null;
	readonly last_error_at: Date | null;
	readonly error_count: number;
}

const HUMAN_LIMIT = 50;

export async function runDrainQueue(ctx: CommandCtx): Promise<number> {
	let minAgeSec = 0;
	if (ctx.flags.age !== undefined) {
		const parsed = parseDurationSpec(ctx.flags.age);
		if (parsed === null) {
			error(`Invalid --age value: ${ctx.flags.age}`);
			info('Examples: 5m, 1h, 24h, 7d');
			return 1;
		}
		minAgeSec = parsed;
	}

	const cutoff = new Date(Date.now() - minAgeSec * 1000);
	// Limit JSON output too — pulling 100k pending rows by accident
	// would not be helpful.  10x the human limit gives plenty of
	// room for jq pipelines without DoS-ing the operator's terminal.
	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const result = await ctx.db.query<{
		id: string;
		recipient: string;
		kind: 'liquid' | 'vesting';
		amount_blurt: string;
		reason: string;
		created_at: Date;
		last_error: string | null;
		last_error_at: Date | null;
		error_count: number;
	}>(
		`SELECT
		   id::text,
		   recipient,
		   kind,
		   amount_blurt::text,
		   reason,
		   created_at,
		   last_error,
		   last_error_at,
		   error_count
		 FROM relay_pending_transfers
		 WHERE broadcast_at IS NULL
		   AND created_at <= $1
		 ORDER BY created_at ASC
		 LIMIT $2`,
		[cutoff, limit]
	);

	const entries: DrainEntry[] = result.rows;

	if (ctx.flags.json === 'true') {
		emitJson({
			min_age_sec: minAgeSec,
			count: entries.length,
			entries: entries.map((e) => ({
				id: e.id,
				recipient: e.recipient,
				kind: e.kind,
				amount_blurt: e.amount_blurt,
				reason: e.reason,
				created_at: e.created_at.toISOString(),
				age_sec: ageSeconds(e.created_at),
				last_error: e.last_error,
				last_error_at: e.last_error_at !== null ? e.last_error_at.toISOString() : null,
				error_count: e.error_count
			}))
		});
		return 0;
	}

	renderHuman(entries, minAgeSec);
	return 0;
}

function renderHuman(entries: readonly DrainEntry[], minAgeSec: number): void {
	const title =
		minAgeSec > 0
			? `Drain queue (entries older than ${formatDuration(minAgeSec)})`
			: 'Drain queue (all pending)';
	section(title);

	if (entries.length === 0) {
		info(
			minAgeSec > 0
				? fmt.green('  No entries match the age filter — queue is healthy.')
				: fmt.green('  Nothing pending — queue is empty.')
		);
		return;
	}

	// Header.
	const header =
		'  ' +
		'AGE'.padEnd(10) +
		'KIND'.padEnd(9) +
		'RECIPIENT'.padEnd(20) +
		'AMOUNT'.padEnd(12) +
		'REASON';
	info(fmt.dim(header));

	for (const e of entries) {
		const age = formatDuration(ageSeconds(e.created_at));
		const recipient = e.recipient.length > 18 ? e.recipient.slice(0, 17) + '…' : e.recipient;
		const amount = parseFloat(e.amount_blurt).toFixed(2) + ' BLURT';
		const errorTail =
			e.error_count > 0
				? fmt.red(`  (errored ${e.error_count}× last: ${e.last_error?.slice(0, 60) ?? '?'})`)
				: '';
		info(
			'  ' +
				age.padEnd(10) +
				e.kind.padEnd(9) +
				recipient.padEnd(20) +
				amount.padEnd(12) +
				e.reason +
				errorTail
		);
	}

	if (entries.length === HUMAN_LIMIT) {
		blank();
		info(
			fmt.dim(
				`  Showing first ${HUMAN_LIMIT}.  More entries may exist; ` + 'use --json for full export.'
			)
		);
	}
}
