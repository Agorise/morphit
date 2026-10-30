/**
 * Morphit ops CLI — `flags` subcommand.
 *
 * Lists moderation flags raised by the indexer's signal detectors — all FOUR
 * that can suppress a reputation (it listed only A and B, so a reputation
 * suppressed by C or D showed nothing here; review 2026-10-29):
 *
 *   - reciprocity:    suspicious_reciprocity (Self-trade Signal B — two
 *                     accounts mutually exchanging high-star reviews)
 *   - related:        related_accounts (Signal A — accounts created close
 *                     together by the same creator)
 *   - pile_on:        one_way_pile_on (Signal C — a cluster of new reviewers
 *                     low-rating one subject), one line per (subject, attacker)
 *   - concentration:  review_concentration (Signal D — a reviewer whose
 *                     reviews mostly go to one subject)
 *
 * The lists and queries are the Moderation screen's own
 * (lib/moderationSignals.ts). Default window is 7 days; `--since=all` for
 * every flag (suppression is not time-limited — `sudo morphit-ops moderation`
 * shows all of them by default and can clear or block).
 *
 * Filters:
 *   --type=reciprocity|related|pile_on|concentration   Only one kind.
 *   --since=DUR                  Window for the report.  Default 7d.
 */

import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';
import {
	cutoffFor,
	fetchConcentrationFlags,
	fetchPileOnFlags,
	fetchReciprocityFlags,
	fetchRelatedFlags,
	windowLabel,
	type RelatedFlag,
	type ReciprocityFlag
} from '../lib/moderationSignals.ts';

const HUMAN_LIMIT = 50;
const TYPES = ['reciprocity', 'related', 'pile_on', 'concentration'] as const;
type FlagType = (typeof TYPES)[number];

export async function runFlags(ctx: CommandCtx): Promise<number> {
	const sinceSpec = ctx.flags.since ?? '7d';
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 24h, 7d, 30d, all');
		return 1;
	}
	const cutoff = cutoffFor(sinceSpec, sinceSec);
	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const type = ctx.flags.type;
	if (type !== undefined && !(TYPES as readonly string[]).includes(type)) {
		error(`Invalid --type value: ${type}`);
		info(`Use: --type=${TYPES.join(' | ')}`);
		return 1;
	}
	const show = (t: FlagType): boolean => type === undefined || type === t;

	const lists = await whileReading(ctx, async () => ({
		reciprocity: show('reciprocity') ? await fetchReciprocityFlags(ctx.db, cutoff, limit) : null,
		related: show('related') ? await fetchRelatedFlags(ctx.db, cutoff, limit) : null,
		pile_on: show('pile_on') ? await fetchPileOnFlags(ctx.db, cutoff, limit) : null,
		concentration: show('concentration')
			? await fetchConcentrationFlags(ctx.db, cutoff, limit)
			: null
	}));

	if (ctx.flags.json === 'true') {
		const rows = (l: ReadonlyArray<ReciprocityFlag | RelatedFlag> | null) =>
			l === null
				? undefined
				: l.map((r) => ({
						account_a: r.account_a,
						account_b: r.account_b,
						detected_at: r.detected_at.toISOString(),
						reason: r.reason
					}));
		emitJson({
			since_sec: cutoff === null ? null : sinceSec,
			type: type ?? 'all',
			reciprocity: rows(lists.reciprocity),
			related: rows(lists.related),
			pile_on: rows(lists.pile_on),
			concentration: rows(lists.concentration)
		});
		return 0;
	}

	section(`Moderation flags (${windowLabel(cutoff, sinceSec, formatDuration)})`);
	const block = (
		title: string,
		l: ReadonlyArray<ReciprocityFlag | RelatedFlag> | null,
		arrow: string,
		flip = false
	): void => {
		if (l === null) return;
		info(fmt.bold(title));
		if (l.length === 0) info(fmt.dim('  None in this window.'));
		for (const r of l) {
			const age = formatDuration(ageSeconds(r.detected_at));
			const [x, y] = flip ? [r.account_b, r.account_a] : [r.account_a, r.account_b];
			info(
				`  ${age.padEnd(10)}@${x} ${arrow} @${y}` +
					(r.reason !== null ? `  ${fmt.dim(r.reason)}` : '')
			);
		}
		blank();
	};
	block('Suspicious reciprocity (Self-trade Signal B):', lists.reciprocity, '↔');
	block('Related accounts (Self-trade Signal A):', lists.related, '↔');
	block('One-way pile-on (Signal C):', lists.pile_on, '→', true);
	block('Review concentration (Signal D):', lists.concentration, '→');
	info(
		fmt.dim('  To block an account or clear a flag, on this server: sudo morphit-ops moderation')
	);
	return 0;
}
