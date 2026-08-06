/**
 * Morphit ops CLI — `signups` subcommand.
 *
 * Lists accounts created via this operator's relay.  Sorted
 * newest-first; default window is 24 hours.
 *
 * The relay-account name comes from MORPHIT_OPS_RELAY_ACCOUNT
 * (default: morphit-relay), matched against accounts.creator.
 * If a different relay creator name is in use, override the env.
 *
 * Note: the CLI has no view of in-flight relay state (rate-limit
 * counters, IP-mismatch attempts).  Those live in the relay
 * process memory.  This subcommand shows what's been COMMITTED
 * to chain — successful signups only.  For abuse signal, see
 * `morphit-ops abuse`.
 *
 * Filters:
 *   --since=DUR    Show signups within the last DUR.  Default 24h.
 */

import type { CommandCtx } from '../lib/ctx.ts';
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

export async function runSignups(ctx: CommandCtx): Promise<number> {
	const sinceSpec = ctx.flags.since ?? '24h';
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 1h, 24h, 7d');
		return 1;
	}
	const cutoff = new Date(Date.now() - sinceSec * 1000);

	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const result = await ctx.db.query<SignupEntry>(
		`SELECT
		   name,
		   created_block_num::text,
		   created_block_time,
		   created_trx_id,
		   first_activity_at
		 FROM accounts
		 WHERE creator = $1
		   AND created_block_time >= $2
		 ORDER BY created_block_time DESC
		 LIMIT $3`,
		[ctx.config.relayAccount, cutoff, limit]
	);

	const entries = result.rows;

	if (ctx.flags.json === 'true') {
		emitJson({
			relay_account: ctx.config.relayAccount,
			since_sec: sinceSec,
			count: entries.length,
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

	renderHuman(entries, sinceSec, ctx.config.relayAccount);
	return 0;
}

function renderHuman(
	entries: readonly SignupEntry[],
	sinceSec: number,
	relayAccount: string
): void {
	section(`Signups via @${relayAccount} (last ${formatDuration(sinceSec)})`);

	if (entries.length === 0) {
		info(fmt.dim('  No signups in this window.'));
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
	const total = entries.length;
	const everActive = entries.filter((e) => e.first_activity_at !== null).length;
	const pct = Math.round((everActive / total) * 100);
	info(
		fmt.dim(
			`  ${total} signups, ${everActive} ever-active (${pct}%).` +
				(total === HUMAN_LIMIT ? '  More may exist; use --json for full export.' : '')
		)
	);
}
