import { describe, expect, it } from 'vitest';
import { sendReviewAndCompletion } from './reviewAndComplete';

function recorder(opts: { completionFails?: boolean; reviewFails?: boolean } = {}) {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			sendReview: async () => {
				calls.push('review');
				if (opts.reviewFails) throw new Error('rpc down');
				return { block_num: 1, trx_id: 't' };
			},
			sendCompletion: async () => {
				calls.push('complete');
				if (opts.completionFails) throw new Error('locked');
			},
			onCompleted: () => calls.push('onCompleted'),
			onCompletionFailed: () => calls.push('onCompletionFailed')
		}
	};
}

describe('Mark complete / review: the completion reaches the chain before the review', () => {
	it('owner completes: completion first, then the review', async () => {
		const r = recorder();
		const out = await sendReviewAndCompletion(r.deps, true);
		expect(r.calls).toEqual(['complete', 'onCompleted', 'review']);
		expect(out.completed).toBe(true);
	});

	it('a failed completion still sends the review', async () => {
		const r = recorder({ completionFails: true });
		const out = await sendReviewAndCompletion(r.deps, true);
		expect(r.calls).toEqual(['complete', 'onCompletionFailed', 'review']);
		expect(out.completed).toBe(false);
	});

	it('not the owner: only the review', async () => {
		const r = recorder();
		await sendReviewAndCompletion(r.deps, false);
		expect(r.calls).toEqual(['review']);
	});

	it('a failed review is reported to the caller (the form shows the error)', async () => {
		const r = recorder({ reviewFails: true });
		await expect(sendReviewAndCompletion(r.deps, true)).rejects.toThrow('rpc down');
	});
});
