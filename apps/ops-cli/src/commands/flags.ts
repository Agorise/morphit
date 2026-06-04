/**
 * Morphit ops CLI — `flags` subcommand.
 *
 * Lists moderation flags raised by the indexer's signal
 * detectors.  Two types:
 *
 *   - reciprocity:  suspicious_reciprocity flags (Self-trade
 *                   Signal B — two accounts mutually exchanging
 *                   high-star reviews with no other counterparties)
 *   - related:      related_accounts flags (Self-trade Signal A —
 *                   accounts created in close temporal proximity
 *                   by the same creator)
 *
 * Default window is 7 days (flags are infrequent on small
 * instances; 24h would usually be empty).
 *
 * Filters:
 *   --type=reciprocity|related   Show only one kind.  Default: both.
 *   --since=DUR                  Window for the report.  Default 7d.
 */

import type { CommandCtx } from '../lib/ctx.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank } from '../render/term.ts';

interface ReciprocityRow {
	account_a: string;
	account_b: string;
	detected_at: Date;
	reason: string | null;
	evidence: unknown;
}

interface RelatedRow {
	account_a: string;
	account_b: string;
	detected_at: Date;
	reason: string;
	evidence: unknown;
}

const HUMAN_LIMIT = 50;

export async function runFlags(ctx: CommandCtx): Promise<number> {
	const sinceSpec = ctx.flags.since ?? '7d';
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 24h, 7d, 30d');
		return 1;
	}
	const cutoff = new Date(Date.now() - sinceSec * 1000);
	const limit = ctx.flags.json === 'true' ? HUMAN_LIMIT * 10 : HUMAN_LIMIT;

	const type = ctx.flags.type;
	if (type !== undefined && type !== 'reciprocity' && type !== 'related') {
		error(`Invalid --type value: ${type}`);
		info('Use: --type=reciprocity or --type=related');
		return 1;
	}

	const showReciprocity = type === undefined || type === 'reciprocity';
	const showRelated = type === undefined || type === 'related';

	const [recipResult, relatedResult] = await Promise.all([
		showReciprocity
			? ctx.db.query<ReciprocityRow>(
					`SELECT
					   account_a,
					   account_b,
					   detected_at,
					   'mutual reviews: ' || mutual_review_count
					     || ' (avg rating ' || round(avg_rating::numeric, 2) || ')' AS reason,
					   jsonb_build_object(
					     'mutual_review_count', mutual_review_count,
					     'avg_rating', avg_rating
					   ) AS evidence
					 FROM suspicious_reciprocity
					 WHERE detected_at >= $1
					 ORDER BY detected_at DESC
					 LIMIT $2`,
					[cutoff, limit]
				)
			: Promise.resolve({ rows: [] as ReciprocityRow[] }),
		showRelated
			? ctx.db.query<RelatedRow>(
					`SELECT
					   account_a,
					   account_b,
					   detected_at,
					   reason,
					   evidence
					 FROM related_accounts
					 WHERE detected_at >= $1
					 ORDER BY detected_at DESC
					 LIMIT $2`,
					[cutoff, limit]
				)
			: Promise.resolve({ rows: [] as RelatedRow[] })
	]);

	const reciprocity = recipResult.rows;
	const related = relatedResult.rows;

	if (ctx.flags.json === 'true') {
		emitJson({
			since_sec: sinceSec,
			type: type ?? 'all',
			reciprocity: showReciprocity
				? reciprocity.map((r: ReciprocityRow) => ({
						account_a: r.account_a,
						account_b: r.account_b,
						detected_at: r.detected_at.toISOString(),
						reason: r.reason,
						evidence: r.evidence
					}))
				: undefined,
			related: showRelated
				? related.map((r: RelatedRow) => ({
						account_a: r.account_a,
						account_b: r.account_b,
						detected_at: r.detected_at.toISOString(),
						reason: r.reason,
						evidence: r.evidence
					}))
				: undefined
		});
		return 0;
	}

	renderHuman(sinceSec, showReciprocity ? reciprocity : null, showRelated ? related : null);
	return 0;
}

function renderHuman(
	sinceSec: number,
	reciprocity: readonly ReciprocityRow[] | null,
	related: readonly RelatedRow[] | null
): void {
	section(`Moderation flags (last ${formatDuration(sinceSec)})`);

	if (reciprocity !== null) {
		info(fmt.bold('Suspicious reciprocity (Self-trade Signal B):'));
		if (reciprocity.length === 0) {
			info(fmt.dim('  None in this window.'));
		} else {
			for (const r of reciprocity) {
				const age = formatDuration(ageSeconds(r.detected_at));
				info(
					`  ${age.padEnd(10)}@${r.account_a} ↔ @${r.account_b}` +
						(r.reason !== null ? `  ${fmt.dim(r.reason)}` : '')
				);
			}
		}
		blank();
	}

	if (related !== null) {
		info(fmt.bold('Related accounts (Self-trade Signal A):'));
		if (related.length === 0) {
			info(fmt.dim('  None in this window.'));
		} else {
			for (const r of related) {
				const age = formatDuration(ageSeconds(r.detected_at));
				info(`  ${age.padEnd(10)}@${r.account_a} ↔ @${r.account_b}` + `  ${fmt.dim(r.reason)}`);
			}
		}
	}
}
