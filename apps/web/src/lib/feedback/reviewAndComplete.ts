/**
 * The order of the two ops "Mark complete / review" sends.
 *
 * From the consensus activation time (2026-11-01) the indexer accepts a review
 * that cites an order only when the pair TRADED on it: they chatted in that
 * order's thread, or the order was completed naming the other party. The
 * owner's "Mark complete / review" sends both a review and the completion. When
 * the pair chatted in another thread (or in none tagged with this order), the
 * review is judged before the completion exists unless the completion is sent
 * FIRST — and the review is then dropped by every indexer while the form says
 * it was sent.
 *
 * broadcastCustomJson returns once the op is in a block, so a review broadcast
 * after the completion returns lands in a later block and is judged after it.
 *
 * The completion stays best-effort: when it fails (locked key, RPC hiccup) the
 * review is still sent — it is what the user typed, and it is accepted anyway
 * when the pair chatted in this order's thread.
 */
export interface ReviewAndCompleteDeps {
	sendReview: () => Promise<{ block_num: number; trx_id: string }>;
	sendCompletion: () => Promise<unknown>;
	/** Called after the completion reached a block. */
	onCompleted?: () => void;
	onCompletionFailed?: (err: unknown) => void;
}

export async function sendReviewAndCompletion(
	deps: ReviewAndCompleteDeps,
	/** The reviewer owns the order and wants it completed with this review. */
	complete: boolean
): Promise<{ review: { block_num: number; trx_id: string }; completed: boolean }> {
	let completed = false;
	if (complete) {
		try {
			await deps.sendCompletion();
			completed = true;
			deps.onCompleted?.();
		} catch (err) {
			deps.onCompletionFailed?.(err);
		}
	}
	const review = await deps.sendReview();
	return { review, completed };
}
