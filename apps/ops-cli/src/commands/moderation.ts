/**
 * Morphit ops CLI — `moderation` subcommand (beta5).
 *
 * The unified moderation screen: it shows the indexer's account-level abuse
 * flags — all FOUR signals that can suppress a reputation (reciprocity B,
 * related accounts A, one-way pile-on C, review concentration D) — annotated
 * with each flagged account's instance-local block status, and — on an
 * interactive terminal — offers block / unblock / clear a flag / undo a
 * clearance as the resolution actions.
 *
 * One window and one set of signals with the main menu's "⚠ N to review"
 * marker (lib/moderationSignals.ts countFlags): by default ALL TIME, because
 * suppression is not time-limited (review, 2026-10-29: the menu counted 2
 * signals over 30 days, this screen 4 over 7, so the menu said "⚠ 2 to review"
 * and the screen "0 flags" plus a `--since=all` hint the menu cannot pass).
 * The Block / Unblock / Clear / Undo / Done loop is offered whether or not the
 * window holds a flag, and Enter means Done.
 *
 * (Operational broadcast failures live under `failed-broadcasts`; the
 * legacy `abuse` and `flags` subcommands remain available from the CLI
 * for scripting / JSON, but are no longer separate menu items.)
 *
 * Flags:
 *   --type=reciprocity|related|pile_on|concentration   Only one signal.
 *   --since=DUR                  Window, e.g. 7d.  Default: all (no window).
 *   --json                       Emit JSON, skip the resolution prompt.
 */

import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';
import { ask, askChoice, askYesNo } from '../init/prompt.ts';
import {
	fetchReciprocityFlags,
	fetchRelatedFlags,
	type ModerationSignal,
	fetchPileOnFlags,
	fetchConcentrationFlags,
	countActiveFlagsOutsideWindow,
	collectFlaggedAccounts,
	fetchBlockStatuses,
	type ReciprocityFlag,
	type RelatedFlag,
	type BlockStatus,
	type ClearanceRow,
	type FlagCounts,
	clearFlag,
	unclearFlag,
	fetchClearances,
	countFlags,
	cutoffFor,
	windowLabel,
	DEFAULT_MODERATION_SINCE
} from '../lib/moderationSignals.ts';
import { applyLocalBlock, normalizeAccount } from '../lib/localBlock.ts';

const HUMAN_LIMIT = 50;

/** The resolution loop's choices; Enter picks the last one, Done. */
export const RESOLUTION_CHOICES = [
	'Block an account',
	'Unblock an account',
	'Clear a flag (restore an account)',
	'Undo a clearance',
	'Done'
] as const;

export async function runModeration(ctx: CommandCtx): Promise<number> {
	const sinceSpec = ctx.flags.since ?? DEFAULT_MODERATION_SINCE;
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 24h, 7d, 30d, all');
		return 1;
	}
	const type = ctx.flags.type;
	// v1.8.12 — all FOUR suppression signals. C and D were never listed here,
	// so an operator saw "0 flags" while a reputation sat suppressed by one of
	// them, with no way to find out which. They suppress exactly like A and B.
	const VALID_TYPES = ['reciprocity', 'related', 'pile_on', 'concentration'];
	if (type !== undefined && !VALID_TYPES.includes(type)) {
		error(`Invalid --type value: ${type}`);
		info(`Use: --type=${VALID_TYPES.join(' | ')}`);
		return 1;
	}
	const showReciprocity = type === undefined || type === 'reciprocity';
	const showRelated = type === undefined || type === 'related';
	const showPileOn = type === undefined || type === 'pile_on';
	const showConcentration = type === undefined || type === 'concentration';
	const json = ctx.flags.json === 'true';
	const cutoff = cutoffFor(sinceSpec, sinceSec);
	const limit = json ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;
	const operator = ctx.config.operatorAccount;

	const { reciprocity, related, pileOn, concentration, blocks, counts } = await whileReading(
		ctx,
		async () => {
			const reciprocity = showReciprocity ? await fetchReciprocityFlags(ctx.db, cutoff, limit) : [];
			const related = showRelated ? await fetchRelatedFlags(ctx.db, cutoff, limit) : [];
			const pileOn = showPileOn ? await fetchPileOnFlags(ctx.db, cutoff, limit) : [];
			const concentration = showConcentration
				? await fetchConcentrationFlags(ctx.db, cutoff, limit)
				: [];
			const accounts = collectFlaggedAccounts(
				[...reciprocity, ...pileOn, ...concentration],
				related
			);
			const blocks = await fetchBlockStatuses(ctx.db, operator, accounts);
			const counts = await countFlags(ctx.db, operator, cutoff);
			return { reciprocity, related, pileOn, concentration, blocks, counts };
		}
	);

	if (json) {
		emitJson({
			since_sec: cutoff === null ? null : sinceSec,
			type: type ?? 'all',
			counts: {
				suspicious_reciprocity: counts.reciprocity,
				related_accounts: counts.related,
				one_way_pile_on: counts.pile_on,
				review_concentration: counts.concentration,
				unresolved: counts.unresolved
			},
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
			pile_on: pileOn.map((r) => ({
				account_a: r.account_a,
				account_b: r.account_b,
				detected_at: r.detected_at.toISOString(),
				reason: r.reason
			})),
			concentration: concentration.map((r) => ({
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

	const hidden = await whileReading(ctx, () => countActiveFlagsOutsideWindow(ctx.db, cutoff));
	renderHuman(
		windowLabel(cutoff, sinceSec, formatDuration),
		{ reciprocity, related, pileOn, concentration },
		{
			reciprocity: showReciprocity,
			related: showRelated,
			pileOn: showPileOn,
			concentration: showConcentration
		},
		counts,
		blocks,
		hidden
	);

	// Interactive resolution: only on a real TTY (the menu path and direct
	// interactive runs). Piped stdin / CI just print the report. Offered even
	// when the window holds no flag: blocking, unblocking and undoing a
	// clearance do not need one.
	if (process.stdin.isTTY !== true) return 0;
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
async function clearFlagFlow(ctx: CommandCtx): Promise<void> {
	// "ALL signals" leads, because it is the common case: a pair that trips
	// Signal A usually trips Signal B too once they review each other, and the
	// operator sees the consequences as one problem. v1.8.12 — offers ALL FOUR
	// signals (it once offered two, and "Both" cleared A and B while the pair
	// was flagged by D — clearing the wrong thing while reporting success).
	const kind = await askChoice(
		'Which flag?',
		[
			'ALL signals for this pair (usual choice)',
			'Mutual-review only (suspicious reciprocity — Signal B)',
			'Related-accounts only (Signal A)',
			'One-way pile-on only (Signal C)',
			'Review concentration only (Signal D)',
			'Cancel'
		],
		5
	);
	if (kind === 5) return;

	const ALL_SIGNALS: readonly ModerationSignal[] = [
		'reciprocity',
		'related',
		'pile_on',
		'concentration'
	];
	const signals: readonly ModerationSignal[] =
		kind === 0
			? ALL_SIGNALS
			: kind === 1
				? ['reciprocity']
				: kind === 2
					? ['related']
					: kind === 3
						? ['pile_on']
						: ['concentration'];
	const accountA = (await ask('First account (without @)')).trim().replace(/^@/, '');
	if (accountA === '') return;
	const accountB = (await ask('Second account (without @)')).trim().replace(/^@/, '');
	if (accountB === '') return;
	if (accountA.toLowerCase() === accountB.toLowerCase()) {
		info(fmt.red('  A flag is always between two DIFFERENT accounts.'));
		return;
	}

	const label = signals.length > 1 ? 'all flags' : `the ${signals[0]} flag`;
	const undo = await askYesNo(`Clear ${label} between @${accountA} and @${accountB}?`, false);
	if (!undo) return;
	const note = (await ask('Note for your own records (optional)')).slice(0, 500);

	let removed = 0;
	await whileReading(
		ctx,
		async () => {
			for (const signal of signals) {
				const { cleared } = await clearFlag(ctx.db, { signal, accountA, accountB, note });
				removed += cleared;
			}
		},
		'Recording the clearance…'
	);
	blank();
	if (removed > 0) {
		info(
			fmt.green(
				`  ✓ Cleared. @${accountA} and @${accountB} are restored: the reputation ` +
					'card returns and their reviews stop being subdued.'
			)
		);
	} else {
		info(
			fmt.dim(
				'  No matching flag was present — the clearance is recorded anyway, ' +
					'so this pair will not be flagged for those signals in future.'
			)
		);
	}
	info(fmt.dim('  Instance-local: nothing was broadcast and no other instance is affected.'));
	for (const s of signals) info(fmt.dim(`  ${clearanceLifetime(s, accountA, accountB)}`));
	info(fmt.dim('  You can take a clearance back with "Undo a clearance".'));
	blank();
}

/** How long a clearance lasts, per signal, in one sentence. PURE. */
export function clearanceLifetime(signal: ModerationSignal, a: string, b: string): string {
	switch (signal) {
		case 'related':
			return 'Related-accounts (Signal A): permanent — it rests on facts that cannot change.';
		case 'reciprocity':
			return (
				'Mutual-review (Signal B): their reviews so far are forgiven, but the pair is still ' +
				'watched — it is flagged again if they build up another full signal’s worth.'
			);
		case 'pile_on':
			// A pile-on clearance is kept with no watermark: the pair is not
			// counted as part of a pile-on again (the detector skips cleared pairs).
			return (
				`One-way pile-on (Signal C): permanent for this pair — the reviews between @${a} and ` +
				`@${b} are not counted as part of a pile-on again. Other reviewers can still raise one.`
			);
		case 'concentration':
			return (
				'Review concentration (Signal D): their concentration so far is forgiven, but the ' +
				'pair is still watched — it is flagged again if they keep reviewing only each other.'
			);
	}
}

/** One clearance as a line. PURE. */
export function describeClearance(r: ClearanceRow): string {
	const life =
		r.watermark === null
			? 'permanent'
			: r.signal === 'reciprocity'
				? `watched beyond ${r.watermark} mutual reviews`
				: `watched beyond ${r.watermark} reviews`;
	return (
		`${r.cleared_at.toISOString().slice(0, 10)}  ${r.signal.padEnd(13)}` +
		`@${r.account_a} ↔ @${r.account_b}  (${life})` +
		(r.note !== '' ? `  ${r.note}` : '')
	);
}

/** Undo a clearance (M1): list them, pick one, confirm (default No). The pair
 *  can then be flagged again at the detector's next pass. */
async function undoClearanceFlow(ctx: CommandCtx): Promise<void> {
	const rows = await whileReading(ctx, () => fetchClearances(ctx.db, 50));
	blank();
	if (rows.length === 0) {
		info(fmt.dim('  No clearances in force — nothing to undo.'));
		return;
	}
	const choice = await askChoice(
		'Which clearance to undo?',
		[...rows.map(describeClearance), 'Cancel'],
		rows.length,
		{ showList: true }
	);
	if (choice === rows.length) return;
	const r = rows[choice]!;
	const ok = await askYesNo(
		`Undo the ${r.signal} clearance for @${r.account_a} and @${r.account_b}? (They can be flagged again.)`,
		false
	);
	if (!ok) return;
	const { removed } = await whileReading(
		ctx,
		() => unclearFlag(ctx.db, { signal: r.signal, accountA: r.account_a, accountB: r.account_b }),
		'Removing the clearance…'
	);
	blank();
	info(
		removed > 0
			? fmt.green(
					`  ✓ Clearance removed. The detector may flag @${r.account_a} and @${r.account_b} ` +
						'again on its next pass, if their activity still warrants it.'
				)
			: fmt.dim('  That clearance was already gone.')
	);
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
	window: string,
	lists: {
		readonly reciprocity: readonly ReciprocityFlag[];
		readonly related: readonly RelatedFlag[];
		readonly pileOn: readonly RelatedFlag[];
		readonly concentration: readonly RelatedFlag[];
	},
	shown: { reciprocity: boolean; related: boolean; pileOn: boolean; concentration: boolean },
	counts: FlagCounts,
	blocks: Map<string, BlockStatus>,
	hidden: { reciprocity: number; related: number; pile_on: number; concentration: number }
): void {
	section(`Moderation — flags & blocking (${window})`);

	// Exact counts (not the length of a capped list), the same ones the main
	// menu's "⚠ N to review" comes from.
	const total = counts.total;
	const blocked = [...blocks.values()].filter((b) => b.state === 'blocked').length;
	info(
		`  ${total} flag${total === 1 ? '' : 's'} ` +
			fmt.dim(
				`(${counts.reciprocity} reciprocity, ${counts.related} related-account, ` +
					`${counts.pile_on} pile-on, ${counts.concentration} concentration)`
			) +
			(total > 0
				? `  ${counts.unresolved} not acted on yet ${fmt.dim('(neither account blocked here)')}`
				: '') +
			(blocked > 0 ? `  ${fmt.red(`${blocked} flagged account(s) currently blocked here`)}` : '')
	);
	// The lists can be windowed (--since), but reputation SUPPRESSION is not:
	// a flag older than the window still suppresses. Say so, with the command
	// that shows them (the default, all time).
	const hiddenTotal = hidden.reciprocity + hidden.related + hidden.pile_on + hidden.concentration;
	if (hiddenTotal > 0) {
		info(
			`  ${fmt.yellow(`⚠ ${hiddenTotal} older flag${hiddenTotal === 1 ? '' : 's'} outside this window`)} ` +
				fmt.dim(
					`(${hidden.reciprocity} reciprocity, ${hidden.related} related-account, ` +
						`${hidden.pile_on} pile-on, ${hidden.concentration} concentration)`
				)
		);
		info(
			fmt.dim(
				'    These STILL suppress reputation. To see and clear them, on this server: sudo morphit-ops moderation'
			)
		);
	}
	blank();

	const more = (n: number, listed: number): void => {
		if (n > listed) info(fmt.dim(`  … and ${n - listed} more (the newest ${listed} are shown).`));
	};

	if (shown.reciprocity) {
		info(fmt.bold('Suspicious reciprocity (Self-trade Signal B):'));
		if (lists.reciprocity.length === 0) info(fmt.dim('  None.'));
		for (const r of lists.reciprocity) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(
				`  ${age.padEnd(10)}${tag(r.account_a, blocks)} ↔ ${tag(r.account_b, blocks)}` +
					(r.reason !== null ? `  ${fmt.dim(r.reason)}` : '')
			);
		}
		more(counts.reciprocity, lists.reciprocity.length);
		blank();
	}

	if (shown.related) {
		info(fmt.bold('Related accounts (Self-trade Signal A):'));
		if (lists.related.length === 0) info(fmt.dim('  None.'));
		for (const r of lists.related) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(
				`  ${age.padEnd(10)}${tag(r.account_a, blocks)} ↔ ${tag(r.account_b, blocks)}  ${fmt.dim(r.reason)}`
			);
		}
		more(counts.related, lists.related.length);
		blank();
	}

	// v1.8.12 — Signals C and D suppress reputation exactly like A and B.
	if (shown.pileOn) {
		info(fmt.bold('One-way pile-on (Signal C):'));
		if (lists.pileOn.length === 0) info(fmt.dim('  None.'));
		for (const r of lists.pileOn) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(
				`  ${age.padEnd(10)}${tag(r.account_b, blocks)} → ${tag(r.account_a, blocks)}  ${fmt.dim(r.reason)}`
			);
		}
		more(counts.pile_on, lists.pileOn.length);
		blank();
	}

	if (shown.concentration) {
		info(fmt.bold('Review concentration (Signal D):'));
		if (lists.concentration.length === 0) info(fmt.dim('  None.'));
		for (const r of lists.concentration) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(
				`  ${age.padEnd(10)}${tag(r.account_a, blocks)} → ${tag(r.account_b, blocks)}  ${fmt.dim(r.reason)}`
			);
		}
		more(counts.concentration, lists.concentration.length);
		blank();
	}

	if (total > 0) {
		info(
			fmt.dim(
				'  A flag is a signal, not a verdict. Blocking hides an account’s listings on THIS instance only ' +
					'(no chain broadcast, no effect on other instances); it is reversible.'
			)
		);
	}
}

/** Interactive block / unblock / clear / undo loop. Enter = Done. Reuses the
 *  same instance-local write path as `morphit-ops block`/`unblock`. */
async function resolutionLoop(ctx: CommandCtx, operator: string): Promise<number> {
	const DONE = RESOLUTION_CHOICES.length - 1;
	for (;;) {
		blank();
		const choice = await askChoice('What would you like to do?', [...RESOLUTION_CHOICES], DONE, {
			showList: true
		});
		if (choice === DONE) return 0;
		if (choice === 2) {
			// A flag is a signal, not a verdict: clearing removes it AND records
			// the decision so the detector does not simply re-raise it.
			await clearFlagFlow(ctx);
			continue;
		}
		if (choice === 3) {
			await undoClearanceFlow(ctx);
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

		const { plan, changed } = await whileReading(
			ctx,
			() => applyLocalBlock(ctx.db, { operator, account, action, reason }),
			action === 'block' ? 'Blocking…' : 'Unblocking…'
		);
		info(`  ${plan.summary}`);
		if (changed && action === 'block') {
			info(fmt.dim(`  @${account}'s listings are now hidden on this instance.`));
		} else if (changed && action === 'unblock') {
			info(fmt.dim(`  @${account}'s listings will show on this instance again.`));
		}
	}
}
