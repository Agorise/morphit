/**
 * review text is judged by one rule everywhere. The web composer
 * checks a comment with @morphit/asset-registry `reviewCommentProblem`; the
 * feedback and feedback-response handlers must refuse exactly the same text,
 * or a review the composer lets through is dropped on chain (or the reverse).
 * Every BMP code point and a few astral ones are compared, plus the length
 * boundary.
 */
import { describe, expect, it } from 'vitest';
import { reviewCommentProblem } from '@morphit/asset-registry';
import feedbackHandler from '$indexer/handlers/feedback';
import feedbackResponseHandler from '$indexer/handlers/feedbackResponse';
import { makeCtx } from '../testutils/context';

// No feedback row exists, so a response whose text passes stops at the lookup.
const db = { query: async () => ({ rows: [], rowCount: 0 }) } as never;

/** 'forbidden' | 'too_long' | 'ok', as each side sees `comment`. */
async function handlerVerdicts(comment: string): Promise<[string, string]> {
	const fb = await feedbackHandler(
		makeCtx({
			signer: 'alice',
			// An invalid permlink is checked right after the comment: reaching it
			// means the comment passed.
			payload: { subject: 'bobby', rating: 5, comment, order_permlink: 'NOT VALID' }
		}),
		db
	);
	const fr = await feedbackResponseHandler(
		makeCtx({ signer: 'bobby', payload: { feedback_trx_id: 'abc123', comment } }),
		db
	);
	const name = (r: { ok: boolean; reason?: string }): string =>
		r.ok
			? 'ok'
			: r.reason === 'comment_forbidden_char'
				? 'forbidden'
				: r.reason === 'comment_too_long'
					? 'too_long'
					: 'ok';
	return [name(fb as never), name(fr as never)];
}

function sharedVerdict(comment: string): string {
	const p = reviewCommentProblem(comment.normalize('NFC'));
	return p === 'forbidden_chars' ? 'forbidden' : (p ?? 'ok');
}

describe('review text: handlers and the shared rule agree', () => {
	it('every BMP code point and a few astral ones', async () => {
		const disagree: string[] = [];
		const points: number[] = [];
		for (let cp = 0; cp <= 0xffff; cp++) if (cp < 0xd800 || cp > 0xdfff) points.push(cp);
		points.push(0x1f600, 0xe0001, 0xe007f, 0x10ffff);
		for (const cp of points) {
			const text = `ok ${String.fromCodePoint(cp)} ok`;
			const want = sharedVerdict(text);
			const [fb, fr] = await handlerVerdicts(text);
			if (fb !== want || fr !== want) {
				disagree.push(
					`U+${cp.toString(16).toUpperCase()} shared=${want} feedback=${fb} response=${fr}`
				);
			}
		}
		expect(disagree).toEqual([]);
	});

	it('the length boundary', async () => {
		for (const n of [255, 256, 257]) {
			const text = '😀'.repeat(n);
			const want = sharedVerdict(text);
			expect(await handlerVerdicts(text)).toEqual([want, want]);
		}
		expect(sharedVerdict('😀'.repeat(257))).toBe('too_long');
	});
});
