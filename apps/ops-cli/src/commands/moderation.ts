/**
 * Morphit ops CLI — `moderation` subcommand (beta5).
 *
 * The unified moderation screen: it shows the indexer's account-level
 * abuse flags (suspicious_reciprocity + related_accounts) annotated
 * with each flagged account's instance-local block status, and — on an
 * interactive terminal — offers block/unblock as the resolution action.
 * It replaces the separate "Abuse alerts" and "Moderation flags" menu
 * items with one screen that goes from signal → decision in one place.
 *
 * (Operational broadcast failures live under `failed-broadcasts`; the
 * legacy `abuse` and `flags` subcommands remain available from the CLI
 * for scripting / JSON, but are no longer separate menu items.)
 *
 * Flags:
 *   --type=reciprocity|related   Show only one signal.  Default: both.
 *   --since=DUR                  Window.  Default 7d.
 *   --json                       Emit JSON, skip the resolution prompt.
 */

import type { CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';
import { ask, askChoice, askYesNo } from '../init/prompt.ts';
import {
	fetchReciprocityFlags,
	fetchRelatedFlags,
	collectFlaggedAccounts,
	fetchBlockStatuses,
	type ReciprocityFlag,
	type RelatedFlag,
	type BlockStatus
} from '../lib/moderationSignals.ts';
import { applyLocalBlock, normalizeAccount } from '../lib/localBlock.ts';

const HUMAN_LIMIT = 50;

export async function runModeration(ctx: CommandCtx): Promise<number> {
	const sinceSpec = ctx.flags.since ?? '7d';
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 24h, 7d, 30d');
		return 1;
	}
	const type = ctx.flags.type;
	if (type !== undefined && type !== 'reciprocity' && type !== 'related') {
		error(`Invalid --type value: ${type}`);
		info('Use: --type=reciprocity or --type=related');
		return 1;
	}
	const showReciprocity = type === undefined || type === 'reciprocity';
	const showRelated = type === undefined || type === 'related';
	const json = ctx.flags.json === 'true';
	const cutoff = new Date(Date.now() - sinceSec * 1000);
	const limit = json ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;
	const operator = ctx.config.officialAccount;

	const reciprocity = showReciprocity ? await fetchReciprocityFlags(ctx.db, cutoff, limit) : [];
	const related = showRelated ? await fetchRelatedFlags(ctx.db, cutoff, limit) : [];
	const accounts = collectFlaggedAccounts(reciprocity, related);
	const blocks = await fetchBlockStatuses(ctx.db, operator, accounts);

	if (json) {
		emitJson({
			since_sec: sinceSec,
			type: type ?? 'all',
			counts: { suspicious_reciprocity: reciprocity.length, related_accounts: related.length },
			reciprocity: reciprocity.map((r) => ({
				account_a: r.account_a,
				account_b: r.account_b,
				detected_at: r.detected_at.toISOString(),
				reason: r.reason
			})),
			related: related.map((r) => ({
				account_a: r.account_a,
				account_b: r.account_b,
				detected_at: r.detected_at.toISOString(),
				reason: r.reason
			})),
			blocks: [...blocks.values()].map((b) => ({
				account: b.account,
				state: b.state,
				origin: b.origin
			}))
		});
		return 0;
	}

	renderHuman(sinceSec, reciprocity, related, blocks);

	// Interactive resolution: only on a real TTY (the menu path and
	// direct interactive runs). Piped stdin / CI just print the report.
	if (process.stdin.isTTY !== true) return 0;
	if (accounts.length === 0) return 0;
	return resolutionLoop(ctx, operator);
}

/** Tag an account name with its block state for display. */
function tag(account: string, blocks: Map<string, BlockStatus>): string {
	const b = blocks.get(account);
	if (b !== undefined && b.state === 'blocked') {
		return `@${account} ${fmt.red('[BLOCKED]')}`;
	}
	return `@${account}`;
}

function renderHuman(
	sinceSec: number,
	reciprocity: readonly ReciprocityFlag[],
	related: readonly RelatedFlag[],
	blocks: Map<string, BlockStatus>
): void {
	section(`Moderation — flags & blocking (last ${formatDuration(sinceSec)})`);

	const total = reciprocity.length + related.length;
	const blocked = [...blocks.values()].filter((b) => b.state === 'blocked').length;
	info(
		`  ${total} flag${total === 1 ? '' : 's'} ` +
			fmt.dim(`(${reciprocity.length} reciprocity, ${related.length} related-account)`) +
			(blocked > 0 ? `  ${fmt.red(`${blocked} flagged account(s) currently blocked here`)}` : '')
	);
	blank();

	info(fmt.bold('Suspicious reciprocity (Self-trade Signal B):'));
	if (reciprocity.length === 0) {
		info(fmt.dim('  None in this window.'));
	} else {
		for (const r of reciprocity) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(
				`  ${age.padEnd(10)}${tag(r.account_a, blocks)} \u2194 ${tag(r.account_b, blocks)}` +
					(r.reason !== null ? `  ${fmt.dim(r.reason)}` : '')
			);
		}
	}
	blank();

	info(fmt.bold('Related accounts (Self-trade Signal A):'));
	if (related.length === 0) {
		info(fmt.dim('  None in this window.'));
	} else {
		for (const r of related) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(
				`  ${age.padEnd(10)}${tag(r.account_a, blocks)} \u2194 ${tag(r.account_b, blocks)}  ${fmt.dim(r.reason)}`
			);
		}
	}
	blank();

	if (total > 0) {
		info(
			fmt.dim(
				'  A flag is a signal, not a verdict. Blocking hides an account\u2019s listings on THIS instance only ' +
					'(no chain broadcast, no effect on other instances); it is reversible.'
			)
		);
	}
}

/** Interactive block/unblock loop. Reuses the same instance-local
 *  write path as `morphit-ops block`/`unblock`. */
async function resolutionLoop(ctx: CommandCtx, operator: string): Promise<number> {
	for (;;) {
		blank();
		const choice = await askChoice(
			'Resolve a flag?',
			['Block an account', 'Unblock an account', 'Done'],
			2,
			{ showList: true }
		);
		if (choice === 2) return 0;
		const action = choice === 0 ? 'block' : 'unblock';

		const raw = await ask(`Which account to ${action}? (leave blank to cancel)`);
		if (raw.trim() === '') continue;
		const account = normalizeAccount(raw);
		if (account === null) {
			error(`"${raw}" is not a valid Blurt account name.`);
			continue;
		}
		if (account === operator) {
			error(`You can't block your own operator account (@${operator}).`);
			continue;
		}

		let reason = '';
		if (action === 'block') {
			reason = (await ask('Reason (optional, shown to the blocked user)')).slice(0, 500);
		}
		const ok = await askYesNo(
			`${action === 'block' ? 'Block' : 'Unblock'} @${account} on this instance?`,
			action === 'unblock'
		);
		if (!ok) continue;

		const { plan, changed } = await applyLocalBlock(ctx.db, { operator, account, action, reason });
		info(`  ${plan.summary}`);
		if (changed && action === 'block') {
			info(fmt.dim(`  @${account}'s listings are now hidden on this instance.`));
		} else if (changed && action === 'unblock') {
			info(fmt.dim(`  @${account}'s listings will show on this instance again.`));
		}
	}
}
