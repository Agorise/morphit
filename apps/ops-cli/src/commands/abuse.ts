/**
 * Morphit ops CLI — `abuse` subcommand.
 *
 * Synthesizes moderation + abuse signals visible to the
 * indexer's database.  Five streams in one report:
 *
 *   1. Persistent broadcast failures — relay_pending_transfers
 *      with error_count >= 3.  Indicates network issue, key
 *      problem, or bad recipient.
 *   2-5. New flags of all FOUR reputation signals raised in the window —
 *      suspicious reciprocity (B), related accounts (A), one-way pile-on (C,
 *      per subject/attacker pair) and review concentration (D) — with the
 *      Moderation screen's own queries (lib/moderationSignals.ts). It showed
 *      only A and B (review, 2026-10-29).
 *
 * Default window: 24h.
 *
 * Note: the relay's process-memory abuse signals (per-IP rate-
 * limit hits, daily-ceiling alerts, reserved-name attempts,
 * IP-mismatch on signup tokens) are NOT in the DB.  See the
 * relay's structured logs for those — they emit
 * `kind: 'CEILING_REACHED'` and similar JSON events.
 *
 * Filters:
 *   --since=DUR    Window for the report.  Default 24h.
 */

import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { applyThreshold } from '../config.ts';
import { ageSeconds, formatDuration, parseDurationSpec } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, info, fmt, error, blank, glyph } from '../render/term.ts';
import {
	fetchConcentrationFlags,
	fetchPileOnFlags,
	fetchReciprocityFlags,
	fetchRelatedFlags,
	type RelatedFlag
} from '../lib/moderationSignals.ts';

interface PersistentFailureRow {
	id: string;
	recipient: string;
	kind: string;
	amount_blurt: string;
	last_error: string | null;
	last_error_at: Date;
	error_count: number;
}

interface ReciprocityRow {
	account_a: string;
	account_b: string;
	detected_at: Date;
	reason: string | null;
}

type RelatedRow = RelatedFlag;

const PER_STREAM_HUMAN_LIMIT = 10;

export async function runAbuse(ctx: CommandCtx): Promise<number> {
	const sinceSpec = ctx.flags.since ?? '24h';
	const sinceSec = parseDurationSpec(sinceSpec);
	if (sinceSec === null) {
		error(`Invalid --since value: ${sinceSpec}`);
		info('Examples: 1h, 24h, 7d');
		return 1;
	}
	const cutoff = new Date(Date.now() - sinceSec * 1000);

	const limit = ctx.flags.json === 'true' ? PER_STREAM_HUMAN_LIMIT * 10 : PER_STREAM_HUMAN_LIMIT;

	const { failures, reciprocity, related, pileOn, concentration } = await whileReading(
		ctx,
		async () => ({
			failures: (
				await ctx.db.query<PersistentFailureRow>(
					`SELECT
				   id::text,
				   recipient,
				   kind,
				   amount_blurt::text,
				   last_error,
				   last_error_at,
				   error_count
				 FROM relay_pending_transfers
				 WHERE last_error_at IS NOT NULL
				   AND last_error_at >= $1
				   AND error_count >= 3
				   AND broadcast_at IS NULL
				 ORDER BY last_error_at DESC
				 LIMIT $2`,
					[cutoff, limit]
				)
			).rows,
			reciprocity: (await fetchReciprocityFlags(ctx.db, cutoff, limit)) as ReciprocityRow[],
			related: await fetchRelatedFlags(ctx.db, cutoff, limit),
			pileOn: await fetchPileOnFlags(ctx.db, cutoff, limit),
			concentration: await fetchConcentrationFlags(ctx.db, cutoff, limit)
		})
	);

	if (ctx.flags.json === 'true') {
		emitJson({
			since_sec: sinceSec,
			counts: {
				persistent_failures: failures.length,
				suspicious_reciprocity: reciprocity.length,
				related_accounts: related.length,
				one_way_pile_on: pileOn.length,
				review_concentration: concentration.length
			},
			persistent_failures: failures.map((f: PersistentFailureRow) => ({
				id: f.id,
				recipient: f.recipient,
				kind: f.kind,
				amount_blurt: f.amount_blurt,
				last_error: f.last_error,
				last_error_at: f.last_error_at.toISOString(),
				error_count: f.error_count
			})),
			suspicious_reciprocity: reciprocity.map((r: ReciprocityRow) => ({
				account_a: r.account_a,
				account_b: r.account_b,
				detected_at: r.detected_at.toISOString(),
				reason: r.reason
			})),
			related_accounts: related.map((r: RelatedRow) => ({
				account_a: r.account_a,
				account_b: r.account_b,
				detected_at: r.detected_at.toISOString(),
				reason: r.reason
			})),
			one_way_pile_on: pileOn.map((r: RelatedRow) => ({
				subject: r.account_a,
				reviewer: r.account_b,
				detected_at: r.detected_at.toISOString(),
				reason: r.reason
			})),
			review_concentration: concentration.map((r: RelatedRow) => ({
				reviewer: r.account_a,
				subject: r.account_b,
				detected_at: r.detected_at.toISOString(),
				reason: r.reason
			}))
		});
		return 0;
	}

	renderHuman(ctx, sinceSec, failures, reciprocity, related, pileOn, concentration);
	return 0;
}

function renderHuman(
	ctx: CommandCtx,
	sinceSec: number,
	failures: readonly PersistentFailureRow[],
	reciprocity: readonly ReciprocityRow[],
	related: readonly RelatedRow[],
	pileOn: readonly RelatedRow[],
	concentration: readonly RelatedRow[]
): void {
	section(`Abuse signals (last ${formatDuration(sinceSec)})`);

	const total =
		failures.length + reciprocity.length + related.length + pileOn.length + concentration.length;
	const status = applyThreshold(total, ctx.config.thresholds.abuseAlerts24h);
	info(
		`  ${glyph(status)} ${total} total event${total === 1 ? '' : 's'} ` +
			fmt.dim(
				`(${failures.length} broadcast failures, ` +
					`${reciprocity.length} reciprocity, ` +
					`${related.length} related-account, ` +
					`${pileOn.length} pile-on, ` +
					`${concentration.length} concentration)`
			)
	);
	blank();

	if (failures.length > 0) {
		info(fmt.bold('Persistent broadcast failures (error_count ≥ 3):'));
		for (const f of failures) {
			const age = formatDuration(ageSeconds(f.last_error_at));
			const errPreview =
				f.last_error !== null && f.last_error.length > 70
					? f.last_error.slice(0, 67) + '…'
					: (f.last_error ?? '?');
			info(
				`  ${age.padEnd(10)}@${f.recipient.padEnd(18)}` +
					` ${f.kind.padEnd(8)} ${parseFloat(f.amount_blurt).toFixed(2)}B ` +
					`(${f.error_count}× errors)`
			);
			info(`    ${fmt.red(errPreview)}`);
		}
		blank();
	}

	if (reciprocity.length > 0) {
		info(fmt.bold('New suspicious-reciprocity flags:'));
		for (const r of reciprocity) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(
				`  ${age.padEnd(10)}@${r.account_a} ↔ @${r.account_b}` +
					(r.reason !== null ? `  ${fmt.dim(r.reason)}` : '')
			);
		}
		blank();
	}

	if (related.length > 0) {
		info(fmt.bold('New related-account flags:'));
		for (const r of related) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(`  ${age.padEnd(10)}@${r.account_a} ↔ @${r.account_b}` + `  ${fmt.dim(r.reason)}`);
		}
		blank();
	}

	if (pileOn.length > 0) {
		info(fmt.bold('New one-way pile-on flags:'));
		for (const r of pileOn) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(`  ${age.padEnd(10)}@${r.account_b} → @${r.account_a}  ${fmt.dim(r.reason)}`);
		}
		blank();
	}

	if (concentration.length > 0) {
		info(fmt.bold('New review-concentration flags:'));
		for (const r of concentration) {
			const age = formatDuration(ageSeconds(r.detected_at));
			info(`  ${age.padEnd(10)}@${r.account_a} → @${r.account_b}  ${fmt.dim(r.reason)}`);
		}
		blank();
	}

	if (total === 0) {
		info(fmt.green('  No abuse signals in this window.'));
		return;
	}

	info(
		fmt.dim(
			'  Note: relay process-memory signals (rate-limit hits, ' +
				'daily-ceiling alerts, IP-mismatch attempts) are NOT' +
				' shown here.  See relay logs for those.'
		)
	);
}
