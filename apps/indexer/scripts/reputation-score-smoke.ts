#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/reputation-score-smoke.ts (cp404)
 *
 * Invariants over the composite reputation score in
 * apps/indexer/src/indexer/reputation/score.ts — the "⭐ 4.06" shown on
 * order cards, distinct from the raw trade count. Locks the fairness
 * properties Ken asked for: good behaviour is rewarded; experience and
 * recency can NEVER rescue a poor or mediocre rating; a single glowing
 * review can't spike a newcomer's score.
 */

import {
	computeReputationScore,
	computeReputationScoreDetailed,
	REPUTATION_PRIOR_MEAN
} from '../src/indexer/reputation/score';

let total = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
	total++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
		if (detail) console.log(`      ${detail}`);
	}
};

const NOW = Date.UTC(2026, 6, 1); // fixed as_of for determinism
const daysAgo = (d: number) => NOW - d * 86_400_000;

// 1. No feedback → null (card shows nothing; 🌱 signals newness).
check('1 zero feedback → null', computeReputationScore({ count: 0, weightedAvg: null, lastFeedbackAtMs: null, asOfMs: NOW }) === null);

// 2. weightedAvg null (defensive) → null.
check('2 null average → null', computeReputationScore({ count: 5, weightedAvg: null, lastFeedbackAtMs: daysAgo(1), asOfMs: NOW }) === null);

// 3. Single 5-star → shrunk well below 5 (can't spike off one review).
{
	const s = computeReputationScore({ count: 1, weightedAvg: 5, lastFeedbackAtMs: daysAgo(1), asOfMs: NOW })!;
	check('3 one 5-star review is shrunk (< 3.8, not 5)', s !== null && s < 3.8, String(s));
}

// 4. Many recent 5-stars → high (approaches 5).
{
	const s = computeReputationScore({ count: 200, weightedAvg: 5, lastFeedbackAtMs: daysAgo(1), asOfMs: NOW })!;
	check('4 200 recent 5-stars → high (≥ 4.8)', s >= 4.8, String(s));
}

// 5. Good behaviour rewarded: more good trades → strictly higher score.
{
	const few = computeReputationScore({ count: 5, weightedAvg: 4.9, lastFeedbackAtMs: daysAgo(2), asOfMs: NOW })!;
	const many = computeReputationScore({ count: 60, weightedAvg: 4.9, lastFeedbackAtMs: daysAgo(2), asOfMs: NOW })!;
	check('5 more good trades → higher score', many > few, `few=${few} many=${many}`);
}

// 6. Experience/recency CANNOT rescue a poor rating.
{
	const bad = computeReputationScore({ count: 500, weightedAvg: 2.0, lastFeedbackAtMs: daysAgo(1), asOfMs: NOW })!;
	// avg 2.0 shrinks slightly toward 3, but the bonus is gated to zero
	// below neutral, so the score stays clearly poor (< 2.5).
	check('6 high-volume poor rating stays poor (< 2.5)', bad < 2.5, String(bad));
}

// 7. Mediocre (neutral) rating gets NO bonus.
{
	const d = computeReputationScoreDetailed({ count: 100, weightedAvg: REPUTATION_PRIOR_MEAN, lastFeedbackAtMs: daysAgo(1), asOfMs: NOW });
	check('7 neutral-rated trader gets zero bonus', d.bonus === 0, JSON.stringify(d));
}

// 8. Recency: a dormant good trader scores lower than an active one.
{
	const active = computeReputationScore({ count: 40, weightedAvg: 4.8, lastFeedbackAtMs: daysAgo(2), asOfMs: NOW })!;
	const dormant = computeReputationScore({ count: 40, weightedAvg: 4.8, lastFeedbackAtMs: daysAgo(400), asOfMs: NOW })!;
	check('8 dormant good trader < active good trader', dormant < active, `active=${active} dormant=${dormant}`);
}

// 9. Always bounded to [0, 5].
{
	const hi = computeReputationScore({ count: 10000, weightedAvg: 5, lastFeedbackAtMs: NOW, asOfMs: NOW })!;
	const lo = computeReputationScore({ count: 10000, weightedAvg: 1, lastFeedbackAtMs: NOW, asOfMs: NOW })!;
	check('9 score bounded within [0,5]', hi <= 5 && lo >= 0, `hi=${hi} lo=${lo}`);
}

// 10. Breakdown is self-consistent: score ≈ clamp(base + bonus).
{
	const d = computeReputationScoreDetailed({ count: 30, weightedAvg: 4.6, lastFeedbackAtMs: daysAgo(10), asOfMs: NOW });
	const recomputed = Math.min(5, (d.base ?? 0) + d.bonus);
	check('10 breakdown consistent (score ≈ base + bonus)', d.score !== null && Math.abs(d.score - recomputed) < 0.02, JSON.stringify(d));
}

console.log('');
if (failed > 0) {
	console.log(`\u2717 ${failed}/${total} reputation-score scenarios failed`);
	process.exit(1);
}
console.log(`\u2713 all ${total} reputation-score scenarios passed`);
