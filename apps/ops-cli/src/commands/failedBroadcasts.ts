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
 *   --offset=N     Skip the newest N (the next page of a long list).
 *
 * Review 2026-10-29: the totals were counted from the (at most 50) rows shown,
 * so a busy window under-reported; a delegation showed "0.00 B" (its amount is
 * its Blurt Power target, amount_bp); "delegation" ran into the next column;
 * and a row whose send only awaits its confirmation was a red ✗ "still stuck".
 *
 * Review of v1.21.18: a row the relay ESCALATED ("outcome … still unknown")
 * was a red ✗ "not sent". The relay could not tell whether it reached the
 * chain and will not send it again by itself; calling it "not sent" invites
 * the operator to pay twice. It is now "may have been sent", with its
 * transaction id and the exact way to look it up first. So is a row whose
 * signed attempt is still open but that has reached the retry limit (the
 * relay no longer settles it). The states mirror apps/relay/src/queue/
 * drainer.ts (its last_error prefixes).
 */

import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';
import { pageNote, parseOffset, windowLabel } from './signups.ts';
import { effectiveEnvValue, resolveInstanceOrigin } from '../lib/instanceOrigin.ts';
import { relayEnvFiles } from '../lib/relayHealthEnvHeal.ts';
import { isHiddenOnlyNode, localIndexerBases } from '../lib/hiddenOnly.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';

interface FailedBroadcast {
	id: string;
	recipient: string;
	kind: string;
	amount_blurt: string;
	amount_bp: string | null;
	reason: string;
	created_at: Date;
	last_error: string | null;
	last_error_at: Date;
	error_count: number;
	broadcast_at: Date | null;
}

interface Totals {
	readonly total: number;
	readonly sent: number;
	readonly waiting: number;
	readonly maybeSent: number;
	readonly stuck: number;
}

const HUMAN_LIMIT = 50;

/** The relay's default MORPHIT_RELAY_QUEUE_MAX_RETRIES (apps/relay config). */
export const DEFAULT_QUEUE_MAX_RETRIES = 3;

/** The retry limit the relay runs with (MORPHIT_RELAY_QUEUE_MAX_RETRIES in its
 *  env files, last one wins; else its default). A row at it is no longer
 *  taken by the relay — not sent again, and not settled either. */
export function relayQueueMaxRetries(root = process.env.MORPHIT_ENV_ROOT ?? ''): number {
	const v = effectiveEnvValue(relayEnvFiles(root), 'MORPHIT_RELAY_QUEUE_MAX_RETRIES');
	const n = v !== null && v.length <= 6 && /^\d+$/.test(v) ? parseInt(v, 10) : NaN;
	return Number.isInteger(n) && n >= 1 ? n : DEFAULT_QUEUE_MAX_RETRIES;
}

/** The relay's last_error prefixes (apps/relay/src/queue/drainer.ts). */
const OPEN_ATTEMPT_RE = /^(outcome_unknown|in_flight trx_id=)/;
const IN_PROGRESS_RE = /^(outcome_unknown|in_flight)\b/;
const ESCALATED_RE = /^escalated:/;

/**
 * A row's state. PURE; mirrors {@link MAYBE_SENT_SQL} / {@link WAITING_SQL}.
 *  - sent: it went out after all;
 *  - waiting: the relay is sending it, or checking the chain for a send whose
 *    answer it did not get — it settles that by itself;
 *  - maybe-sent: it may be on the chain, and the relay will not look again or
 *    send it again: escalated, or an open attempt at the retry limit;
 *  - stuck: not sent.
 */
export function broadcastState(
	e: {
		readonly broadcast_at: Date | null;
		readonly last_error: string | null;
		readonly error_count?: number;
	},
	maxRetries = DEFAULT_QUEUE_MAX_RETRIES
): 'sent' | 'waiting' | 'maybe-sent' | 'stuck' {
	if (e.broadcast_at !== null) return 'sent';
	const le = e.last_error ?? '';
	const atLimit = (e.error_count ?? 0) >= maxRetries;
	if (ESCALATED_RE.test(le) || (atLimit && OPEN_ATTEMPT_RE.test(le))) return 'maybe-sent';
	if (!atLimit && IN_PROGRESS_RE.test(le)) return 'waiting';
	return 'stuck';
}

/** The transaction id a row's last_error names (40 hex), or null. PURE. */
export function rowTxid(lastError: string | null): string | null {
	return /\btrx_id=([0-9a-f]{40})\b/.exec(lastError ?? '')?.[1] ?? null;
}

/** The amount as the operator knows it: a delegation's Blurt Power target. */
export function amountText(e: {
	readonly kind: string;
	readonly amount_blurt: string;
	readonly amount_bp?: string | null;
}): string {
	if (e.kind === 'delegation' && e.amount_bp !== null && e.amount_bp !== undefined)
		return `${parseFloat(e.amount_bp)} BP`;
	return `${parseFloat(e.amount_blurt).toFixed(2)} BLURT`;
}

/** SQL: an open signed attempt (it may be on the network). */
const OPEN_ATTEMPT_SQL = `(last_error LIKE 'outcome_unknown%' OR last_error LIKE 'in_flight trx_id=%')`;
/** SQL, the retry limit as `cap`: the relay is still sending / settling it. */
export const WAITING_SQL = (cap: string): string =>
	`(broadcast_at IS NULL AND error_count < ${cap} AND (last_error LIKE 'outcome_unknown%' OR last_error LIKE 'in_flight%'))`;
/** SQL: it may be on the chain and the relay will not look again. */
export const MAYBE_SENT_SQL = (cap: string): string =>
	`(broadcast_at IS NULL AND (last_error LIKE 'escalated:%' OR (error_count >= ${cap} AND ${OPEN_ATTEMPT_SQL})))`;

const WINDOW_SQL = `last_error_at IS NOT NULL AND last_error_at >= $1`;

/** How the operator looks a transaction up on THIS node. */
export interface LookupWays {
	/** The local indexer, e.g. http://127.0.0.1:8081 (its /v1/chain/tx asks
	 *  the chain the way this node does: over Tor/I2P on a hidden-only node). */
	readonly indexerBase: string;
	/** This node's own public explorer, when it has a clearnet origin and is
	 *  not hidden-only; null otherwise (a link is a clearnet hint). */
	readonly explorerOrigin: string | null;
}

/** The real ways, read from this server's files. Never throws. */
export function lookupWays(): LookupWays {
	const hidden = isHiddenOnlyNode();
	let origin: string | null = null;
	if (!hidden) {
		try {
			const o = resolveInstanceOrigin(defaultRepoRoot(), false).origin;
			origin = /^https:\/\//.test(o) && !/\.onion\b|\.i2p\b/.test(o) ? o : null;
		} catch {
			origin = null;
		}
	}
	return { indexerBase: localIndexerBases()[0] ?? 'http://127.0.0.1:8081', explorerOrigin: origin };
}

/** The exact steps to find out whether a "may have been sent" row was paid.
 *  PURE. */
export function lookupSteps(
	e: { readonly last_error: string | null; readonly recipient: string },
	ways: LookupWays,
	relayAccount: string
): string[] {
	const txid = rowTxid(e.last_error);
	if (txid === null && !/^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/.test(relayAccount))
		return [
			`Its transaction id was not recorded. Before sending it again, look for a payment to @${e.recipient} ` +
				"in this node's relay account's history (on this server, sudo morphit-ops status shows the account), " +
				`on this server: curl -s '${ways.indexerBase}/v1/account/<relay account>/history?limit=1000'`
		];
	if (txid === null)
		return [
			`Its transaction id was not recorded. Before sending it again, look for a payment to @${e.recipient} ` +
				`in @${relayAccount}'s history, on this server: ` +
				`curl -s '${ways.indexerBase}/v1/account/${relayAccount}/history?limit=1000'` +
				(ways.explorerOrigin !== null
					? ` (or open ${ways.explorerOrigin}/en/explorer/account/${relayAccount})`
					: '')
		];
	return [
		`Look up transaction ${txid} before sending it again, on this server: ` +
			`curl -s ${ways.indexerBase}/v1/chain/tx/${txid}` +
			(ways.explorerOrigin !== null
				? ` (or open ${ways.explorerOrigin}/en/explorer/tx/${txid})`
				: '')
	];
}

export async function runFailedBroadcasts(
	ctx: CommandCtx,
	deps: { readonly ways?: LookupWays; readonly maxRetries?: number } = {}
): Promise<number> {
	const sinceSpec = (ctx.flags.since ?? '24h').replace(/\s+/g, '');
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 1h, 24h, 7d, all');
		return 1;
	}
	const offset = parseOffset(ctx.flags.offset);
	if (offset === null) {
		error(`Invalid --offset value: ${ctx.flags.offset ?? ''}`);
		info('It is how many to skip, a whole number: --offset=50');
		return 1;
	}
	const cap = deps.maxRetries ?? relayQueueMaxRetries();
	const cutoff = new Date(Date.now() - sinceSec * 1000);
	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const [result, counts] = await whileReading(ctx, () =>
		Promise.all([
			ctx.db.query<FailedBroadcast>(
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
		   error_count,
		   broadcast_at
		 FROM relay_pending_transfers
		 WHERE ${WINDOW_SQL}
		 ORDER BY last_error_at DESC, id DESC
		 LIMIT $2 OFFSET $3`,
				[cutoff, limit, offset]
			),
			// The totals of the WHOLE window, not of the rows fetched.
			ctx.db.query<{ total: string; sent: string; waiting: string; maybe_sent: string }>(
				`SELECT
		   COUNT(*)::text AS total,
		   COUNT(*) FILTER (WHERE broadcast_at IS NOT NULL)::text AS sent,
		   COUNT(*) FILTER (WHERE ${WAITING_SQL('$2')})::text AS waiting,
		   COUNT(*) FILTER (WHERE ${MAYBE_SENT_SQL('$2')})::text AS maybe_sent
		 FROM relay_pending_transfers
		 WHERE ${WINDOW_SQL}`,
				[cutoff, cap]
			)
		])
	);

	const entries = result.rows;
	const c = counts.rows[0];
	const num = (v: string | undefined): number => (v !== undefined ? parseInt(v, 10) || 0 : 0);
	const total = c !== undefined ? num(c.total) : entries.length;
	const sent = num(c?.sent);
	const waiting = num(c?.waiting);
	const maybeSent = num(c?.maybe_sent);
	const totals: Totals = {
		total,
		sent,
		waiting,
		maybeSent,
		stuck: Math.max(0, total - sent - waiting - maybeSent)
	};

	if (ctx.flags.json === 'true') {
		emitJson({
			since_sec: sinceSec,
			count: entries.length,
			offset,
			total: totals.total,
			truncated: totals.total > offset + entries.length,
			sent: totals.sent,
			waiting_for_confirmation: totals.waiting,
			may_have_been_sent: totals.maybeSent,
			not_sent: totals.stuck,
			entries: entries.map((e: FailedBroadcast) => ({
				id: e.id,
				recipient: e.recipient,
				kind: e.kind,
				amount_blurt: e.amount_blurt,
				amount_bp: e.amount_bp,
				reason: e.reason,
				created_at: e.created_at.toISOString(),
				last_error: e.last_error,
				last_error_at: e.last_error_at.toISOString(),
				error_count: e.error_count,
				broadcast_at: e.broadcast_at !== null ? e.broadcast_at.toISOString() : null,
				resolved: e.broadcast_at !== null,
				state: broadcastState(e, cap),
				trx_id: rowTxid(e.last_error)
			}))
		});
		return 0;
	}

	renderHuman(entries, totals, windowLabel(sinceSpec, sinceSec), {
		cap,
		ways: deps.ways ?? lookupWays(),
		relayAccount: ctx.config.relayAccount,
		offset,
		command: `sudo morphit-ops failed-broadcasts --since=${sinceSpec}`
	});
	return 0;
}

function renderHuman(
	entries: readonly FailedBroadcast[],
	t: Totals,
	window: string,
	o: {
		readonly cap: number;
		readonly ways: LookupWays;
		readonly relayAccount: string;
		readonly offset: number;
		readonly command: string;
	}
): void {
	section(`Failed broadcasts (${window})`);

	if (t.total === 0) {
		info(fmt.green('  No broadcast failures in this window.'));
		return;
	}

	const parts = [
		`${t.sent} sent after all`,
		`${t.waiting} being sent or confirmed by the relay`,
		...(t.maybeSent > 0 ? [`${t.maybeSent} may have been sent`] : []),
		`${t.stuck} not sent`
	];
	info(
		`  ${t.total} ${t.total === 1 ? 'payment' : 'payments'} had errors  ` +
			fmt.dim(`(${parts.join(', ')})`)
	);
	blank();

	for (const e of entries) {
		const age = formatDuration(ageSeconds(e.last_error_at));
		const state = broadcastState(e, o.cap);
		const mark =
			state === 'sent'
				? fmt.green('✓')
				: state === 'waiting'
					? fmt.yellow('…')
					: state === 'maybe-sent'
						? fmt.yellow('?')
						: fmt.red('✗');
		const recipient = e.recipient.length > 18 ? e.recipient.slice(0, 17) + '…' : e.recipient;
		info(
			`  ${mark} ${age.padEnd(10)}` +
				`@${recipient.padEnd(20)}` +
				`${e.kind.padEnd(12)}` +
				`${amountText(e).padEnd(14)}` +
				fmt.dim(
					state === 'waiting'
						? `(being sent or confirmed${e.error_count > 0 ? `; ${e.error_count}× errors before` : ''})`
						: state === 'maybe-sent'
							? '(may have been sent: the relay could not tell, and will not send it again)'
							: `(${e.error_count}× errors)`
				)
		);
		if (e.last_error !== null) {
			const errMsg = e.last_error.length > 100 ? e.last_error.slice(0, 97) + '…' : e.last_error;
			info(`    ${state === 'stuck' ? fmt.red(errMsg) : fmt.dim(errMsg)}`);
		}
		if (state === 'maybe-sent')
			for (const line of lookupSteps(e, o.ways, o.relayAccount)) info(`    ${line}`);
	}
	if (entries.length === 0 || t.total > o.offset + entries.length || o.offset > 0) {
		const note = pageNote({
			shown: entries.length,
			offset: o.offset,
			total: t.total,
			noun: 'payments',
			order: 'newest first',
			command: o.command
		});
		if (note !== null) {
			blank();
			info(fmt.dim(`  ${note}`));
		}
	}
	if (t.maybeSent > 0) {
		blank();
		info(
			fmt.dim(
				'  "May have been sent": if the lookup shows the transaction, it was paid — do not send it again. ' +
					'Only if it answers "no such transaction on chain" was it not paid; then re-queue it as ' +
					'docs/OPERATIONS.md, "Responding to a relay-queue-stuck alert", says.'
			)
		);
	}
	if (t.stuck > 0) {
		blank();
		info(
			fmt.dim(
				'  Why a payment was not sent, on this server: sudo journalctl -u morphit-relay -e --no-pager'
			)
		);
	}
}
