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
 *   --offset=N   Skip the oldest N (the next page of a long list).
 *
 * Output:
 *   - default:   human-readable table, max 50 rows
 *   - --json:    array of all matching entries
 */

import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';
import { pageNote, parseOffset } from './signups.ts';

interface DrainEntry {
	readonly id: string;
	readonly recipient: string;
	readonly kind: 'liquid' | 'vesting' | 'delegation';
	readonly amount_blurt: string;
	/** The Blurt Power target of a delegation (null for transfers). */
	readonly amount_bp: string | null;
	readonly reason: string;
	readonly created_at: Date;
	readonly last_error: string | null;
	readonly last_error_at: Date | null;
	readonly error_count: number;
}

const HUMAN_LIMIT = 50;

/** What a queue row pays for, in words (the indexer's reason codes:
 *  handlers/feedback.ts, loyalty.ts, lowBalanceScanner.ts). Unknown codes are
 *  shown as they are. PURE. */
export function reasonText(reason: string): string {
	if (reason === 'welcome_bonus_liquid') return 'welcome bonus (BLURT)';
	if (reason === 'welcome_bonus_vesting') return 'welcome bonus (Blurt Power)';
	if (reason === 'first_listing_fee_welcome') return 'first-listing welcome (Blurt Power)';
	if (reason === 'dust_refill') return 'small top-up for fees';
	const m = /^loyalty_milestone_(\d+)$/.exec(reason);
	if (m) return `loyalty reward (${m[1]} BLURT milestone)`;
	return reason;
}

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

	const offset = parseOffset(ctx.flags.offset);
	if (offset === null) {
		error(`Invalid --offset value: ${ctx.flags.offset ?? ''}`);
		info('It is how many to skip, a whole number: --offset=50');
		return 1;
	}

	const cutoff = new Date(Date.now() - minAgeSec * 1000);
	// Limit JSON output too — pulling 100k pending rows by accident
	// would not be helpful.  10x the human limit gives plenty of
	// room for jq pipelines without DoS-ing the operator's terminal.
	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const [result, countResult] = await whileReading(ctx, () =>
		Promise.all([
			ctx.db.query<{
				id: string;
				recipient: string;
				kind: 'liquid' | 'vesting' | 'delegation';
				amount_blurt: string;
				amount_bp: string | null;
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
		   amount_bp::text,
		   reason,
		   created_at,
		   last_error,
		   last_error_at,
		   error_count
		 FROM relay_pending_transfers
		 WHERE broadcast_at IS NULL
		   AND created_at <= $1
		 ORDER BY created_at ASC, id ASC
		 LIMIT $2 OFFSET $3`,
				[cutoff, limit, offset]
			),
			ctx.db.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count
		 FROM relay_pending_transfers
		 WHERE broadcast_at IS NULL
		   AND created_at <= $1`,
				[cutoff]
			)
		])
	);

	const entries: DrainEntry[] = result.rows;
	const total = parseInt(countResult.rows[0]?.count ?? String(entries.length), 10);

	if (ctx.flags.json === 'true') {
		emitJson({
			min_age_sec: minAgeSec,
			count: entries.length,
			offset,
			total,
			truncated: total > offset + entries.length,
			entries: entries.map((e) => ({
				id: e.id,
				recipient: e.recipient,
				kind: e.kind,
				amount_blurt: e.amount_blurt,
				amount_bp: e.amount_bp,
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

	renderHuman(entries, minAgeSec, total, {
		offset,
		command: `sudo morphit-ops drain-queue${ctx.flags.age !== undefined ? ` --age=${ctx.flags.age.replace(/\s+/g, '')}` : ''}`
	});
	return 0;
}

function renderHuman(
	entries: readonly DrainEntry[],
	minAgeSec: number,
	total: number,
	page: { readonly offset: number; readonly command: string }
): void {
	const title =
		minAgeSec > 0
			? `Drain queue (entries older than ${formatDuration(minAgeSec)})`
			: 'Drain queue (all pending)';
	section(title);

	if (entries.length === 0 && total > 0) {
		const note = pageNote({ shown: 0, total, noun: 'payments', order: 'oldest first', ...page });
		if (note !== null) info(fmt.dim(`  ${note}`));
		return;
	}
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
		'KIND'.padEnd(11) +
		'RECIPIENT'.padEnd(20) +
		'AMOUNT'.padEnd(12) +
		'REASON';
	info(fmt.dim(header));

	for (const e of entries) {
		const age = formatDuration(ageSeconds(e.created_at));
		const recipient = e.recipient.length > 18 ? e.recipient.slice(0, 17) + '…' : e.recipient;
		// 2026-10-08: a delegation's amount is its Blurt Power target; it showed
		// as "0.00 BLURT". And a row with no error yet but an unconfirmed send
		// (outcome_unknown) showed nothing at all, so a row re-sent every minute
		// for days looked healthy.
		const amount =
			e.kind === 'delegation' && e.amount_bp !== null
				? `${parseFloat(e.amount_bp)} BP`
				: parseFloat(e.amount_blurt).toFixed(2) + ' BLURT';
		const state = e.last_error !== null && e.last_error !== '' ? lastErrorText(e.last_error) : '';
		const errorTail =
			e.error_count > 0
				? fmt.red(`  (errored ${e.error_count}× last: ${state || '?'})`)
				: state !== ''
					? fmt.yellow(`  (waiting: ${state})`)
					: '';
		info(
			'  ' +
				age.padEnd(10) +
				e.kind.padEnd(11) +
				recipient.padEnd(20) +
				amount.padEnd(12) +
				reasonText(e.reason) +
				errorTail
		);
	}

	const note = pageNote({
		shown: entries.length,
		total,
		noun: 'payments',
		order: 'oldest first',
		...page
	});
	if (note !== null) {
		blank();
		info(fmt.dim(`  ${note}`));
	}
	if (entries.some((e) => e.error_count > 0)) {
		blank();
		info(
			fmt.dim(
				'  A payment marked "errored" is retried by the relay a few times, then left for you. ' +
					'Why it failed, on this server: sudo journalctl -u morphit-relay -e --no-pager. ' +
					'What to do about each kind of failure: docs/OPERATIONS.md, "Responding to a relay-queue-stuck alert".'
			)
		);
	}
}

/** A row's state, short, with what the nodes answered kept whole (review
 *  2026-10-08: cutting at 120 characters dropped it on exactly the rows that
 *  stopped retrying). The relay writes the answer after ` cause=` (an
 *  unconfirmed send) or ` — the nodes answered: ` (one that never landed). */
export function lastErrorText(lastError: string): string {
	for (const sep of [' cause=', ' — the nodes answered: ']) {
		const at = lastError.indexOf(sep);
		if (at !== -1)
			return (
				`${lastError.slice(0, Math.min(at, 100))} — the nodes answered: ` +
				lastError.slice(at + sep.length, at + sep.length + 200)
			);
	}
	return lastError.slice(0, 160);
}
