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
	type BlockStatus,
	clearFlag,
	fetchClearances
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
	const operator = ctx.config.operatorAccount;

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

/** Clear a self-trade flag so a wrongly-flagged account is restored.
 *
 *  Restores immediately: every reputation/review read path still reads the
 *  flag tables, so removing the row brings the reputation card back and
 *  un-subdues the reviews with no rebuild. The recorded clearance is what
 *  makes it stick — the detectors would otherwise re-raise the identical flag
 *  on their next pass, so a bare delete appears to work and then silently
 *  undoes itself.
 */
async function clearFlagFlow(ctx: CommandCtx, operator: string): Promise<void> {
	void operator; // clearances are instance-wide, not per-operator
	// "Both" leads, because it is the common case: a pair that trips Signal A
	// (same creator, near-simultaneous first activity) usually trips Signal B
	// too once they review each other, and the operator sees the consequences
	// as one problem — a hidden reputation card AND subdued reviews.
	const kind = await askChoice(
		'Which flag?',
		[
			'Both signals for this pair (usual choice)',
			'Mutual-review flag only (suspicious reciprocity — Signal B)',
			'Related-accounts flag only (Signal A)',
			'Show clearances already in force',
			'Cancel'
		],
		4
	);
	if (kind === 4) return;

	if (kind === 3) {
		const rows = await fetchClearances(ctx.db, 50);
		blank();
		if (rows.length === 0) {
			info(fmt.dim('  No clearances in force.'));
		} else {
			for (const r of rows) {
				const life =
					r.watermark === null
						? fmt.dim('permanent')
						: fmt.dim(`watched from ${r.watermark} mutual reviews`);
				info(
					`  ${r.cleared_at.toISOString().slice(0, 10)}  ${fmt.bold(r.signal.padEnd(12))}` +
						`@${r.account_a} \u2194 @${r.account_b}  ${life}` +
						(r.note !== '' ? `  ${fmt.dim(r.note)}` : '')
				);
			}
			info(
				fmt.dim(
					'  A clearance keeps the detector from re-raising that pair. ' +
						'Re-run this step and pick the same signal to undo one.'
				)
			);
		}
		blank();
		return;
	}

	const signals: readonly ('reciprocity' | 'related')[] =
		kind === 0 ? ['reciprocity', 'related'] : kind === 1 ? ['reciprocity'] : ['related'];
	const accountA = (await ask('First account (without @)')).trim().replace(/^@/, '');
	if (accountA === '') return;
	const accountB = (await ask('Second account (without @)')).trim().replace(/^@/, '');
	if (accountB === '') return;
	if (accountA.toLowerCase() === accountB.toLowerCase()) {
		info(fmt.red('  A flag is always between two DIFFERENT accounts.'));
		return;
	}

	const label = signals.length === 2 ? 'both flags' : `the ${signals[0]} flag`;
	const undo = await askYesNo(`Clear ${label} between @${accountA} and @${accountB}?`, false);
	if (!undo) return;
	const note = (await ask('Note for your own records (optional)')).slice(0, 500);

	let removed = 0;
	for (const signal of signals) {
		const { cleared } = await clearFlag(ctx.db, { signal, accountA, accountB, note });
		removed += cleared;
	}
	blank();
	if (removed > 0) {
		info(
			fmt.green(
				`  \u2713 Cleared. @${accountA} and @${accountB} are restored: the reputation ` +
					'card returns and their reviews stop being subdued.'
			)
		);
	} else {
		info(
			fmt.dim(
				'  No matching flag row was present — the clearance is recorded anyway, ' +
					'so this pair will not be flagged for those signals in future.'
			)
		);
	}
	info(
		fmt.dim(
			'  Instance-local: nothing was broadcast and no other instance is affected.'
		)
	);
	if (signals.includes('related')) {
		info(fmt.dim('  Related-accounts (Signal A): permanent — it rests on facts that cannot change.'));
	}
	if (signals.includes('reciprocity')) {
		info(
			fmt.dim(
				'  Mutual-review (Signal B): their reviews so far are forgiven, but the pair is ' +
					'still watched — it re-fires if they build up another full signal\u2019s worth.'
			)
		);
	}
	blank();
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
			[
				'Block an account',
				'Unblock an account',
				'Clear a flag (restore an account)',
				'Done'
			],
			2,
			{ showList: true }
		);
		if (choice === 3) return 0;
		if (choice === 2) {
			// v1.8.9 — a flag is a signal, not a verdict, and until now the only
			// options were to block or to live with it. A legitimate operator can
			// trip Signals A/B (two handles on one LAN will do it), which hides
			// their reputation card and subdues every review behind a "reviewers
			// flagged as related" pill. Clearing removes the flag AND records the
			// decision so the detector does not simply re-raise it next pass.
			await clearFlagFlow(ctx, operator);
			continue;
		}
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
