/**
 * Reviews this device sent, and what became of them (v1.21.17).
 *
 * THE BUG. A review is shown as sent the moment it is in a block, but it only
 * COUNTS once the indexers accept it. When they refused it — a review of a
 * first trade (a first-buy order, which paid no listing fee) was refused until
 * the consensus activation time — the stars showed until the next reload, and
 * then the chat asked for a review again, every visit, while the reviewer knew
 * he had sent one. Nobody said it had not counted.
 *
 * THE FIX. What was sent is kept on this device (per reviewer), and the
 * reviewer's own instance is asked what it did with the review
 * (`/v1/feedback/status`) — whether or not this device sent it, so a review
 * sent before this version, or from another device, is known too:
 *   - indexed  → it counts; nothing more to say;
 *   - unknown  → not seen (none sent, or still on its way);
 *   - refused, a first trade's review still missing its proof
 *     (`waiting_for_transfer`): "not counted yet", naming who must send whom
 *     at least 50 BLURT in one transfer; asked about again now and then;
 *   - refused, and the instance says the same review would now be accepted
 *     (`resend_from`): from that time the review form again, with what was
 *     written (before it, "not counted yet — from <day>");
 *   - refused otherwise → "not counted", no prompt (sending it again would be
 *     refused the same way).
 */
import { readable, writable, type Readable } from 'svelte/store';
import type { FeedbackRecord } from '@morphit/indexer-client';
import { getFeedbackStatus } from '$lib/indexer/client';
import { personGet, personSet, personStorageTier } from '$lib/storage/personStorage';

export interface SentReview {
	readonly reviewer: string;
	readonly subject: string;
	readonly order_permlink: string;
	readonly rating: 1 | 2 | 3 | 4 | 5;
	readonly comment: string | null;
	readonly trx_id: string;
	/** ISO time it reached a block. */
	readonly sent_at: string;
}

/** In the session's person storage ($lib/storage/personStorage): the reviews
 *  name the people traded with, so they go where the session's own state goes
 *  (the device for a remembered session, the tab for "just this session",
 *  nowhere while signed out) and never outlive the sign-out. */
export const SENT_REVIEWS_KEY = 'morphit.sentReviews.v1';
const STORAGE_KEY = SENT_REVIEWS_KEY;
/** Enough for any trader's recent reviews; the oldest go first. */
export const SENT_REVIEWS_MAX = 200;
/** Older than this, the indexer's own list has long been the truth. */
export const SENT_REVIEWS_KEEP_MS = 180 * 24 * 60 * 60 * 1000;

/** Bumped on every write, so views reading `sentReviewFor` re-run. */
export const sentReviewsTick = writable(0);

/** In memory too: storage can be unavailable (private window, blocked site
 *  data) and the review must still show for this visit. */
let memory: SentReview[] | null = null;

function isSentReview(x: unknown): x is SentReview {
	if (typeof x !== 'object' || x === null) return false;
	const r = x as Record<string, unknown>;
	return (
		typeof r.reviewer === 'string' &&
		typeof r.subject === 'string' &&
		typeof r.order_permlink === 'string' &&
		typeof r.rating === 'number' &&
		Number.isInteger(r.rating) &&
		r.rating >= 1 &&
		r.rating <= 5 &&
		(r.comment === null || typeof r.comment === 'string') &&
		typeof r.trx_id === 'string' &&
		typeof r.sent_at === 'string'
	);
}

function load(): SentReview[] {
	if (memory !== null) return memory;
	const list = readStored() ?? [];
	const cutoff = Date.now() - SENT_REVIEWS_KEEP_MS;
	memory = list.filter((r) => Date.parse(r.sent_at) >= cutoff);
	return memory;
}

function save(list: SentReview[]): void {
	memory = list;
	try {
		personSet(STORAGE_KEY, JSON.stringify(list));
	} catch {
		/* no storage: kept in memory for this visit */
	}
	sentReviewsTick.update((n) => n + 1);
}

/** What storage holds now (null when it cannot be read). */
function readStored(): SentReview[] | null {
	try {
		const raw = personGet(STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter(isSentReview) : [];
	} catch {
		return null;
	}
}

// A session started or ended (another account, or none): read again.
personStorageTier.subscribe(() => {
	memory = null;
	sentReviewsTick.update((n) => n + 1);
});

// Another tab kept (or dropped) a review: read storage again next time.
if (typeof window !== 'undefined') {
	try {
		window.addEventListener('storage', (e) => {
			if (e.key !== STORAGE_KEY && e.key !== null) return;
			memory = null;
			sentReviewsTick.update((n) => n + 1);
		});
	} catch {
		/* no window events: this tab only */
	}
}

const same = (r: SentReview, reviewer: string, subject: string, permlink: string): boolean =>
	r.reviewer === reviewer && r.subject === subject && r.order_permlink === permlink;

/** Keep a review this device just sent (the newest per reviewer, subject and
 *  order replaces an older one). */
export function rememberSentReview(r: SentReview): void {
	if (!r.reviewer || !r.subject || !r.order_permlink) return;
	// Merge with storage as it is now: another tab may have kept a review
	// since this one last read it, and writing this tab's stale list back
	// would erase it. (What only this tab holds — storage refused it — stays.)
	const stored = readStored();
	if (stored !== null && memory !== null) {
		const key = (x: SentReview): string => [x.reviewer, x.subject, x.order_permlink].join('\u0000');
		const merged = new Map<string, SentReview>();
		for (const x of [...memory, ...stored]) {
			const k = key(x);
			const had = merged.get(k);
			if (had === undefined || x.sent_at > had.sent_at) merged.set(k, x);
		}
		memory = [...merged.values()].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
	}
	const rest = load().filter((x) => !same(x, r.reviewer, r.subject, r.order_permlink));
	save([...rest, r].slice(-SENT_REVIEWS_MAX));
}

/** The review `reviewer` sent `subject` about this order from this device. */
export function sentReviewFor(
	reviewer: string,
	subject: string,
	orderPermlink: string
): SentReview | null {
	return load().find((r) => same(r, reviewer, subject, orderPermlink)) ?? null;
}

/** Every review `reviewer` sent from this device, newest first. */
export function sentReviewsBy(reviewer: string): SentReview[] {
	return load()
		.filter((r) => r.reviewer === reviewer)
		.slice()
		.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
}

/** A sent review shown as a record (stars and comment) until the indexer's
 *  own record arrives. */
export function sentReviewAsRecord(r: SentReview): FeedbackRecord {
	return {
		id: -1,
		reviewer: r.reviewer,
		subject: r.subject,
		rating: r.rating,
		comment: r.comment,
		order_permlink: r.order_permlink,
		created_at: r.sent_at,
		source_trx_id: r.trx_id,
		responses: []
	};
}

/** What was sent, as the instance has it on chain (a refused review is not in
 *  the indexer's list, so this is where its stars and words come from when
 *  this device did not keep them — it was sent before v1.21.17, or from
 *  another device). */
export interface ReviewOnChain {
	readonly rating: 1 | 2 | 3 | 4 | 5;
	readonly comment: string | null;
}

export type SentReviewVerdict =
	/** The instance has not answered yet. */
	| { readonly kind: 'checking' }
	/** The instance has not seen this review (none sent, or still on its way),
	 *  or could not say. */
	| { readonly kind: 'pending' }
	| { readonly kind: 'counted' }
	/** Refused for now; it counts if sent again from `from` (ISO). */
	| { readonly kind: 'later'; readonly from: string; readonly sent: ReviewOnChain | null }
	/** Refused before, and it would count now: ask for it again. */
	| { readonly kind: 'resend'; readonly sent: ReviewOnChain | null }
	/** A first trade's review: it counts (sent again) once `from` has sent
	 *  `to` at least 50 BLURT in one transfer on or after `after` (ISO) — the
	 *  proof of the trade the indexers go by. */
	| {
			readonly kind: 'needs_transfer';
			readonly from: string;
			readonly to: string;
			readonly after: string;
			readonly sent: ReviewOnChain | null;
	  }
	| { readonly kind: 'refused'; readonly reason: string; readonly sent: ReviewOnChain | null };

export interface ReviewStatusAnswer {
	readonly state: 'indexed' | 'refused' | 'unknown';
	readonly reason?: string;
	readonly resend_from?: string;
	/** The block time of the newest send the instance has seen. */
	readonly block_time?: string;
	readonly trx_id?: string;
	readonly rating?: number;
	readonly comment?: string | null;
	readonly waiting_for_transfer?: { readonly from: string; readonly to: string };
}

/** The consensus activation time from which a first trade's review counts
 *  (the indexer's CONSENSUS_V2_ACTIVATION_TIME): the BLURT transfer that
 *  proves the trade must be on or after it. */
export const FIRST_TRADE_PROOF_FROM = '2026-11-01T00:00:00Z';
/** How often a review waiting for that transfer is asked about again. */
export const NEEDS_TRANSFER_RECHECK_MS = 10 * 60_000;

function onChain(a: ReviewStatusAnswer): ReviewOnChain | null {
	const r = a.rating;
	if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 5) return null;
	return { rating: r as 1 | 2 | 3 | 4 | 5, comment: a.comment ?? null };
}

/** What the instance's answer means for the reviewer, at `nowMs`. */
export function sentReviewVerdict(
	answer: ReviewStatusAnswer | null,
	nowMs: number
): SentReviewVerdict {
	if (answer === null || answer.state === 'unknown') return { kind: 'pending' };
	if (answer.state === 'indexed') return { kind: 'counted' };
	const sent = onChain(answer);
	const w = answer.waiting_for_transfer;
	if (w !== undefined && typeof w.from === 'string' && typeof w.to === 'string') {
		return { kind: 'needs_transfer', from: w.from, to: w.to, after: FIRST_TRADE_PROOF_FROM, sent };
	}
	if (answer.resend_from !== undefined) {
		const from = Date.parse(answer.resend_from);
		if (Number.isFinite(from)) {
			return nowMs < from
				? { kind: 'later', from: answer.resend_from, sent }
				: { kind: 'resend', sent };
		}
	}
	return { kind: 'refused', reason: answer.reason ?? '', sent };
}

/** How often a review not seen yet is asked about again. */
export const SENT_REVIEW_RECHECK_MS = 60_000;
/** …and for how long (then it stays "sent" until the next visit). */
export const SENT_REVIEW_RECHECK_FOR_MS = 30 * 60_000;

/** One review, as its op names it; `trx_id` and `sent_at` (when it reached
 *  a block) when this device sent it. */
export interface ReviewRef {
	readonly reviewer: string;
	readonly subject: string;
	readonly order_permlink: string;
	readonly trx_id?: string;
	readonly sent_at?: string;
}

/** The review `reviewer` wrote of `subject` about an order, with what this
 *  device knows of its own send (`sent`, if it sent one): its transaction and
 *  when it reached a block, which decide which refusal is about it and when it
 *  counts as lost. Every watcher is given its ref from here. */
export function reviewRefOf(
	reviewer: string,
	subject: string,
	orderPermlink: string,
	sent: SentReview | null
): ReviewRef {
	return {
		reviewer,
		subject,
		order_permlink: orderPermlink,
		...(sent !== null ? { trx_id: sent.trx_id, sent_at: sent.sent_at } : {})
	};
}

/** A review this device sent that the instance has still not seen this long
 *  after its block: it never made it (the transaction expired, its block was
 *  dropped). Asked for again rather than shown as sent for good. */
export const SENT_REVIEW_LOST_AFTER_MS = 60 * 60_000;

/** Does a refusal stand for the send `r`? One of THIS send does; one of
 *  another transaction only when it is not older than this send — a newer
 *  send (from another device, say) is the instance's latest word. An older
 *  refusal says nothing about this send, still on its way. Without this
 *  send's time, only its own transaction counts. */
export function refusalStandsFor(r: ReviewRef, answer: ReviewStatusAnswer): boolean {
	if (r.trx_id === undefined || answer.trx_id === undefined || answer.trx_id === r.trx_id) {
		return true;
	}
	const refusedAt = answer.block_time !== undefined ? Date.parse(answer.block_time) : NaN;
	const sentAt = r.sent_at !== undefined ? Date.parse(r.sent_at) : NaN;
	if (!Number.isFinite(refusedAt) || !Number.isFinite(sentAt)) return false;
	return refusedAt >= sentAt;
}

const watchers = new Map<string, Readable<SentReviewVerdict>>();

/** Watch what the instance did with a review. Asks at once; while a review
 *  this device sent is not seen yet, asks again; flips from "later" to
 *  "resend" when the time comes, without a reload. */
export function watchSentReview(r: ReviewRef): Readable<SentReviewVerdict> {
	const key = [r.reviewer, r.subject, r.order_permlink, r.trx_id ?? ''].join('\u0000');
	const existing = watchers.get(key);
	if (existing) return existing;
	const w = readable<SentReviewVerdict>({ kind: 'checking' }, (set) => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const ctl = new AbortController();
		const started = Date.now();
		const tick = async (): Promise<void> => {
			let answer: ReviewStatusAnswer | null = null;
			try {
				const res = await getFeedbackStatus(
					{ reviewer: r.reviewer, subject: r.subject, order_permlink: r.order_permlink },
					ctl.signal
				);
				if (res.ok) answer = res.data;
				// A refusal of an EARLIER send says nothing about this one, still
				// on its way: after "send it again", the old refusal must not ask
				// a third time. A newer one (sent from another device) stands.
				if (answer !== null && answer.state === 'refused' && !refusalStandsFor(r, answer)) {
					answer = null;
				}
			} catch {
				/* the instance could not say */
			}
			if (stopped) return;
			let v = sentReviewVerdict(answer, Date.now());
			const sentAtMs = r.sent_at !== undefined ? Date.parse(r.sent_at) : NaN;
			const lostAtMs = sentAtMs + SENT_REVIEW_LOST_AFTER_MS;
			// Sent from here and still not seen an hour after its block: lost.
			if (v.kind === 'pending' && r.trx_id !== undefined && Date.now() >= lostAtMs) {
				v = { kind: 'resend', sent: null };
			}
			set(v);
			if (v.kind === 'later') {
				// Flip to "send it again" when the day comes. A browser fires a
				// timer set further out than ~24.8 days at once, so a longer wait
				// asks again at that cap instead.
				const MAX_TIMER_MS = 2 ** 31 - 1;
				const wait = Math.max(Date.parse(v.from) - Date.now() + 1_000, 0);
				timer =
					wait > MAX_TIMER_MS
						? setTimeout(() => void tick(), MAX_TIMER_MS)
						: setTimeout(() => set({ kind: 'resend', sent: v.sent }), wait);
			} else if (v.kind === 'needs_transfer') {
				// The transfer may come at any time: look again now and then.
				timer = setTimeout(() => void tick(), NEEDS_TRANSFER_RECHECK_MS);
			} else if (v.kind === 'pending' && r.trx_id !== undefined) {
				if (Date.now() - started < SENT_REVIEW_RECHECK_FOR_MS) {
					timer = setTimeout(() => void tick(), SENT_REVIEW_RECHECK_MS);
				} else if (Number.isFinite(lostAtMs)) {
					// Asked often enough; once more when it would count as lost.
					timer = setTimeout(() => void tick(), Math.max(lostAtMs - Date.now(), 0) + 1_000);
				}
			}
		};
		void tick();
		return () => {
			stopped = true;
			ctl.abort();
			if (timer !== null) clearTimeout(timer);
		};
	});
	watchers.set(key, w);
	return w;
}

/** Sign-out: forget the reviews held in memory and every watcher, so the
 *  next account in this tab neither sees them nor writes them back (the
 *  sign-out sweep removes the stored copy). */
export function forgetSentReviewsOnSignOut(): void {
	memory = null;
	watchers.clear();
	sentReviewsTick.update((n) => n + 1);
}

/** Tests only. */
export function _resetSentReviewsForTests(): void {
	memory = null;
	watchers.clear();
}
