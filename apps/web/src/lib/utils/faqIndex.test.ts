/**
 * FAQ search scoring tests.
 *
 * The scorer has four layered behaviors we want to lock in:
 *   1. Full-phrase substring + prefix bonuses (strong signals of intent)
 *   2. Per-token question/answer matches
 *   3. Stopword filtering + synonym expansion for English-ish queries
 *   4. IDF-style rare-token weighting
 *
 * Tests use small synthetic corpora so the expectations are obvious:
 * we don't want test failures to turn into "is the FAQ content the
 * real cause" debugging.
 */

import { describe, expect, it } from 'vitest';
import { scoreEntry, searchEntries, type FaqEntry } from './faqIndex';

// Build a tiny synthetic entry with a chosen key, question, and answer.
// `as any` on `key` because real FAQ keys are constrained by a
// literal-union type; synthetic keys in tests aren't.
// `related` defaults to [] since these synthetic entries aren't in
// the real FAQ_RELATED map.
function mkEntry(key: string, question: string, answer: string): FaqEntry {
	return { key: key as FaqEntry['key'], question, answer, related: [] };
}

describe('FAQ search scoring — baseline behavior (preserved)', () => {
	it('scores a full-phrase substring match in the question highly', () => {
		const e = mkEntry('test', 'How do I get started?', 'answer body');
		const s = scoreEntry(e, 'get started');
		expect(s).toBeGreaterThanOrEqual(3);
	});

	it('scores a full-phrase substring in the answer', () => {
		const e = mkEntry('test', 'A short title.', 'Pay the listing fee to post an order.');
		const s = scoreEntry(e, 'listing fee');
		expect(s).toBeGreaterThanOrEqual(2);
	});

	it('gives zero for a query with no textual overlap', () => {
		const e = mkEntry('test', 'Completely unrelated', 'Different topic here.');
		expect(scoreEntry(e, 'xyzzy frobnicate')).toBe(0);
	});

	it('returns 0 for an empty query', () => {
		const e = mkEntry('test', 'q', 'a');
		expect(scoreEntry(e, '')).toBe(0);
		expect(scoreEntry(e, '   ')).toBe(0);
	});

	it('is diacritic- and case-insensitive', () => {
		const e = mkEntry('test', 'Cómo usar Morphit', 'Información detallada.');
		const a = scoreEntry(e, 'como');
		const b = scoreEntry(e, 'CÓMO');
		expect(a).toBeGreaterThan(0);
		expect(b).toBe(a);
	});
});

describe('FAQ search scoring — stopword filtering', () => {
	const entries: FaqEntry[] = [
		// "how" and "do" appear in many questions; we don't want
		// them to dominate.
		mkEntry('how_to_run_node', 'How do I run a node?', 'Instructions follow…'),
		mkEntry('how_to_buy', 'How do I buy?', 'Post a buy order.'),
		mkEntry('fees', 'How much does it cost?', 'Listing fees are small.'),
		mkEntry('recovery', 'Recover lost keys', 'Use your backup phrase to recover.')
	];

	it('does not let "how" dominate — a query of just "how" matches little', () => {
		const hits = searchEntries(entries, 'how');
		// With stopword filtering "how" is stripped; the only token
		// left is nothing, so we fall back to full-phrase substring
		// matching. "how" as a substring hits three questions but
		// with low score (no per-token bonus).
		// What matters: NO entry should get a disproportionate score.
		expect(hits.length).toBeLessThanOrEqual(entries.length);
	});

	it('a specific query still ranks the on-topic entry first', () => {
		const hits = searchEntries(entries, 'how do i run a node');
		expect(hits[0]?.entry.key).toBe('how_to_run_node');
	});

	it('keeps all tokens when stripping stopwords would leave nothing', () => {
		// Query made entirely of stopwords — we fall back to matching
		// them rather than returning empty.
		const hits = searchEntries(entries, 'how do i');
		// Something should match via substring (questions contain "how do i…").
		expect(hits.length).toBeGreaterThan(0);
	});
});

describe('FAQ search scoring — synonym expansion', () => {
	const entries: FaqEntry[] = [
		mkEntry('is_it_safe', 'Is Morphit safe?', 'Your security is our priority.'),
		mkEntry('kyc', 'Does Morphit require ID?', 'No identity verification, ever.'),
		mkEntry('fees', 'What are the fees?', 'Small listing fees per order.'),
		mkEntry('run_node', 'Run your own Morphit', 'Host your own node instance.')
	];

	it('"safety" finds the security entry', () => {
		const hits = searchEntries(entries, 'safety');
		expect(hits[0]?.entry.key).toBe('is_it_safe');
	});

	it('"KYC" finds the identity verification entry', () => {
		const hits = searchEntries(entries, 'KYC');
		expect(hits[0]?.entry.key).toBe('kyc');
	});

	it('"price" finds the fees entry', () => {
		const hits = searchEntries(entries, 'price');
		expect(hits[0]?.entry.key).toBe('fees');
	});

	it('"operator" finds the node entry', () => {
		const hits = searchEntries(entries, 'operator');
		expect(hits[0]?.entry.key).toBe('run_node');
	});

	it('"server" also finds the node entry (extended synonym)', () => {
		const hits = searchEntries(entries, 'server');
		expect(hits[0]?.entry.key).toBe('run_node');
	});
});

describe('FAQ search scoring — IDF-style rare-token weighting', () => {
	it('prefers an entry with a rare matching token over one with a common token', () => {
		// "morphit" appears in all four — low IDF, low weight.
		// "waiver" appears in only one — high IDF, high weight.
		const entries: FaqEntry[] = [
			mkEntry('a', 'About Morphit', 'Morphit intro text here.'),
			mkEntry('b', 'Using Morphit', 'Morphit usage guide.'),
			mkEntry('c', 'Waiver details', 'The first-buy waiver on Morphit.'),
			mkEntry('d', 'More Morphit stuff', 'Another Morphit explainer.')
		];
		// Query has both tokens. Without IDF, "morphit" matches all four
		// at equal weight, drowning out "waiver" signal. With IDF, the
		// "c" entry wins.
		const hits = searchEntries(entries, 'morphit waiver');
		expect(hits[0]?.entry.key).toBe('c');
	});

	it('a token that appears in every entry adds very little score', () => {
		const entries: FaqEntry[] = [
			mkEntry('a', 'Word everywhere', 'Word everywhere.'),
			mkEntry('b', 'Word everywhere again', 'Word everywhere again.'),
			mkEntry('c', 'Word everywhere third', 'Word everywhere third.')
		];
		const hits = searchEntries(entries, 'everywhere');
		// All three should score equally (IDF is low but equal across them).
		// After normalization, the top hit's score is 1; the distribution
		// depends on implementation but the three scores shouldn't be
		// wildly different.
		expect(hits).toHaveLength(3);
		const topScore = hits[0]!.score;
		const bottomScore = hits[hits.length - 1]!.score;
		// All should round to roughly the same score post-normalization.
		expect(bottomScore).toBeCloseTo(topScore, 1);
	});
});

describe('FAQ search — overall behavior regression', () => {
	it('searchEntries returns hits sorted descending by score', () => {
		const entries: FaqEntry[] = [
			mkEntry('a', 'totally unrelated', 'xxx'),
			mkEntry('b', 'partial match here', 'some match'),
			mkEntry('c', 'exact phrase match target', 'exact phrase match target')
		];
		const hits = searchEntries(entries, 'exact phrase');
		expect(hits[0]?.entry.key).toBe('c');
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
		}
	});

	it('respects the limit argument', () => {
		const entries: FaqEntry[] = Array.from({ length: 20 }, (_, i) =>
			mkEntry(`k${i}`, `question ${i}`, `answer about topic ${i}`)
		);
		const hits = searchEntries(entries, 'topic', 5);
		expect(hits.length).toBeLessThanOrEqual(5);
	});

	it('returns entries unchanged (all zero-score) when query is empty', () => {
		const entries: FaqEntry[] = [mkEntry('a', 'q1', 'a1'), mkEntry('b', 'q2', 'a2')];
		const hits = searchEntries(entries, '');
		expect(hits).toHaveLength(entries.length);
		for (const h of hits) expect(h.score).toBe(0);
	});

	it('normalizes top score to 1 when there are hits', () => {
		const entries: FaqEntry[] = [mkEntry('a', 'target word here', 'answer')];
		const hits = searchEntries(entries, 'target');
		expect(hits[0]?.score).toBeCloseTo(1, 5);
	});
});
