/**
 * The review and review-response forms refuse exactly the text the indexer
 * refuses (the shared rule in @morphit/asset-registry). A comment the client
 * lets through but the indexer drops is broadcast, paid for and then silently
 * lost.
 */
import { describe, expect, it } from 'vitest';
import { reviewCommentProblem } from '@morphit/asset-registry';
import { validateFeedback } from './feedback';
import { validateFeedbackResponse } from './feedbackResponse';

const CORPUS: string[] = [
	'great trade, fast and friendly',
	'emoji 👍🏽 and accents: café, Zürich, 東京',
	'line separator',
	'paragraph separator',
	'word⁠joiner',
	'invisible⁢times',
	'invisible⁤plus',
	'zero​width',
	'bidi ‮override',
	'isolate ⁦x⁩',
	'bom﻿',
	'tab\there',
	'x'.repeat(256),
	'x'.repeat(257),
	'👍'.repeat(256),
	'👍'.repeat(257)
];

function feedbackRefuses(comment: string): boolean {
	try {
		validateFeedback('alice', { subject: 'bob-trader', rating: 5, comment });
		return false;
	} catch {
		return true;
	}
}

function responseRefuses(comment: string): boolean {
	try {
		validateFeedbackResponse({ feedback_trx_id: 'ab'.repeat(20), comment });
		return false;
	} catch {
		return true;
	}
}

describe('review text: the client refuses what the indexer refuses, and only that', () => {
	it.each(CORPUS.map((c) => [JSON.stringify(c).slice(0, 40), c]))('%s', (_label, comment) => {
		const indexerRefuses = reviewCommentProblem(comment) !== null;
		expect(feedbackRefuses(comment)).toBe(indexerRefuses);
		expect(responseRefuses(comment)).toBe(indexerRefuses);
	});
});
