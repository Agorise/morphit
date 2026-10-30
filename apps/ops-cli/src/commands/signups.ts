/**
 * Morphit ops CLI — `signups` subcommand.
 *
 * Lists accounts created via this operator's relay.  Sorted
 * newest-first; default window is 24 hours.
 *
 * The relay-account name is this server's own (relayAccountFromEnv:
 * MORPHIT_OPS_RELAY_ACCOUNT, else MORPHIT_RELAY_ACCOUNT from morphit.env;
 * there is no default), matched against accounts.creator. When none is
 * known, main.ts stops before this runs.
 *
 * Note: the CLI has no view of in-flight relay state (rate-limit
 * counters, IP-mismatch attempts).  Those live in the relay
 * process memory.  This subcommand shows what's been COMMITTED
 * to chain — successful signups only.  For abuse signal, see
 * `morphit-ops abuse`.
 *
 * Filters:
 *   --since=DUR    Show signups within the last DUR.  Default 24h.
 *   --offset=N     Skip the newest N (the next page of a long list).
 */

import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';

interface SignupEntry {
	readonly name: string;
	readonly created_block_num: string;
	readonly created_block_time: Date;
	readonly created_trx_id: string;
	readonly first_activity_at: Date | null;
}

const HUMAN_LIMIT = 100;

/** The report window in words: `--since=all` is "all time", not "last
 *  36500d" (its stand-in, a century). PURE. */
export function windowLabel(sinceSpec: string, sinceSec: number): string {
	if (sinceSpec.trim().toLowerCase() === 'all' || sinceSec >= 100 * 365 * 86400) return 'all time';
	return `last ${formatDuration(sinceSec)}`;
}

/** `--offset=N`: how many to skip, so a long list is read page by page
 *  (0 when not given); null when it is not a whole number ≥ 0. PURE. */
export function parseOffset(raw: string | undefined): number | null {
	if (raw === undefined) return 0;
	const t = raw.trim();
	if (!/^\d{1,9}$/.test(t)) return null;
	return parseInt(t, 10);
}

/** The line under a list that does not show everything: which ones are shown,
 *  and the exact command that shows the next ones (`command` without its
 *  --offset). null when the whole list is shown. It used to send the operator
 *  to a shorter window (the same newest rows again) or to --json (capped too):
 *  neither could show the rest. PURE. */
export function pageNote(a: {
	readonly shown: number;
	readonly offset: number;
	readonly total: number;
	readonly order: string;
	readonly noun: string;
	readonly command: string;
}): string | null {
	const { shown, offset, total } = a;
	if (offset === 0 && shown >= total) return null;
	if (shown === 0)
		return (
			`No more to show: there ${total === 1 ? 'is' : 'are'} ${total} ${a.noun} in all, ` +
			`and --offset=${offset} skips past them. The first ones, on this server: ${a.command}`
		);
	const range = `Showing ${offset + 1}–${offset + shown} of ${total} ${a.noun}, ${a.order}.`;
	if (offset + shown >= total) return `${range} These are the last of them.`;
	return `${range} The next ones, on this server: ${a.command} --offset=${offset + shown}`;
}

export async function runSignups(ctx: CommandCtx): Promise<number> {
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
		info('It is how many to skip, a whole number: --offset=100');
		return 1;
	}
	const cutoff = new Date(Date.now() - sinceSec * 1000);

	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const [result, countResult] = await whileReading(ctx, () =>
		Promise.all([
			ctx.db.query<SignupEntry>(
				`SELECT
		   name,
		   created_block_num::text,
		   created_block_time,
		   created_trx_id,
		   first_activity_at
		 FROM accounts
		 WHERE creator = $1
		   AND created_block_time >= $2
		 ORDER BY created_block_time DESC, name ASC
		 LIMIT $3 OFFSET $4`,
				[ctx.config.relayAccount, cutoff, limit, offset]
			),
			// How many there are in the window, however many are listed.
			ctx.db.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count
		 FROM accounts
		 WHERE creator = $1
		   AND created_block_time >= $2`,
				[ctx.config.relayAccount, cutoff]
			)
		])
	);

	const entries = result.rows;
	const total = parseInt(countResult.rows[0]?.count ?? String(entries.length), 10);

	if (ctx.flags.json === 'true') {
		emitJson({
			relay_account: ctx.config.relayAccount,
			since_sec: sinceSec,
			count: entries.length,
			offset,
			total,
			truncated: total > offset + entries.length,
			entries: entries.map((e: SignupEntry) => ({
				name: e.name,
				created_block_num: e.created_block_num,
				created_block_time: e.created_block_time.toISOString(),
				created_trx_id: e.created_trx_id,
				first_activity_at: e.first_activity_at !== null ? e.first_activity_at.toISOString() : null
			}))
		});
		return 0;
	}

	renderHuman(entries, windowLabel(sinceSpec, sinceSec), ctx.config.relayAccount, total, {
		offset,
		command: `sudo morphit-ops signups --since=${sinceSpec}`
	});
	return 0;
}

function renderHuman(
	entries: readonly SignupEntry[],
	window: string,
	relayAccount: string,
	total: number,
	page: { readonly offset: number; readonly command: string }
): void {
	section(`Signups via @${relayAccount} (${window})`);

	if (entries.length === 0) {
		const note =
			total > 0
				? pageNote({ shown: 0, total, noun: 'signups', order: 'newest first', ...page })
				: null;
		info(fmt.dim(`  ${note ?? 'No signups in this window.'}`));
		return;
	}

	info(
		fmt.dim('  ' + 'AGE'.padEnd(10) + 'ACCOUNT'.padEnd(20) + 'BLOCK'.padEnd(12) + 'FIRST ACTIVITY')
	);
	for (const e of entries) {
		const age = formatDuration(ageSeconds(e.created_block_time));
		const acct = e.name.length > 18 ? e.name.slice(0, 17) + '…' : e.name;
		const firstActivity =
			e.first_activity_at !== null
				? formatDuration(ageSeconds(e.first_activity_at)) + ' ago'
				: fmt.dim('— never active');
		info('  ' + age.padEnd(10) + acct.padEnd(20) + e.created_block_num.padEnd(12) + firstActivity);
	}

	blank();
	const shown = entries.length;
	const everActive = entries.filter((e) => e.first_activity_at !== null).length;
	const pct = Math.round((everActive / shown) * 100);
	const note = pageNote({
		shown,
		total,
		noun: 'signups',
		order: 'newest first',
		...page
	});
	info(
		fmt.dim(
			note !== null
				? `  ${total} signups in this window; of the ${shown} listed, ${everActive} ever active (${pct}%).`
				: `  ${shown} signups, ${everActive} ever-active (${pct}%).`
		)
	);
	if (note !== null) info(fmt.dim(`  ${note}`));
}
