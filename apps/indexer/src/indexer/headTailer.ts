/**
 * Morphit indexer — chat head-block fast-path tailer (cp403 [1], ADR-0048).
 *
 * PROBLEM. The durable poller (poller.ts) only applies blocks up to
 * `last_irreversible_block_num` (ADR-0008), so a chat message isn't
 * emitted over SSE until it's irreversible. On Blurt (Graphene/DPoS)
 * the last-irreversible block trails the head by ~15-20 blocks — roughly
 * 45-60 seconds. That is the entire chat-latency problem: the frontend
 * is already push-based (SSE), but the push doesn't fire until the
 * message is irreversible.
 *
 * SOLUTION. This tailer polls the chain HEAD (not the irreversible
 * point) every few seconds, extracts `morphit_chat_v1` ops from new
 * head blocks, and emits each as a fast-path event on the chatEventBus.
 * The SSE handler forwards it to matching subscribers as a provisional
 * `message_appended`, so the recipient sees it within a few seconds.
 *
 * HARD INVARIANTS (the safety contract — read before changing anything):
 *
 *  1. NEVER writes to the database. Not one row. The durable poller
 *     remains the SOLE source of truth for chat history (and for orders,
 *     fees, transfers, everything). This tailer only reads (the block
 *     feed + a block-list lookup) and emits in-process events.
 *
 *  2. CHAT ONLY. It extracts exactly one op id — `morphit_chat_v1`.
 *     Orders, fees, feedback, transfers, and every other op are ignored
 *     here; they stay irreversible-only, always. A head-block op is not
 *     yet irreversible and must never drive money or state.
 *
 *  3. REORG IS ACCEPTABLE. A head block can be orphaned by a fork. If a
 *     message shown via the fast path is orphaned, it simply never
 *     reaches durable history — the user saw it briefly and it's gone.
 *     That trade-off is fine for chat and is the whole reason orders et
 *     al. are excluded. We don't track block hashes or attempt rollback.
 *
 *  4. BLOCK LIST IS ENFORCED. Before emitting, we run the SAME block
 *     check the durable handler runs (recipient has blocked sender →
 *     drop). Skipping it would let a blocked sender's message flash up
 *     live even though the recipient blocked them — a real block bypass.
 *     This is the one gate we MUST replicate. (The anti-spam gates —
 *     stranger-fee + rate limits — are deliberately NOT replicated here:
 *     the durable pass still enforces them for persistent history, and a
 *     spammer's message being briefly visible before it fails to persist
 *     is a bounded, acceptable degradation. The block check is the only
 *     one whose bypass would be a genuine safety hole.)
 *
 *  5. CLIENT-TAG GATED. We only emit messages whose header carries a
 *     non-empty `client_tag`. That tag is how the client dedupes this
 *     provisional message against its later durable twin. A message with
 *     no client_tag can't be deduped, so we let it arrive via the
 *     durable path only (≈60s, but never doubled). Every Morphit-composed
 *     message has a client_tag, so this affects nothing in practice.
 *
 *  6. NEVER CRASHES THE PROCESS. Every tick is wrapped; RPC/parse errors
 *     are logged and the loop retries next interval. A broken fast path
 *     must never take down the indexer — the durable poller is unaffected.
 *
 * ALWAYS ON (v1.7.0, ADR-0051 — the opt-out was removed, not renamed).
 * The matching client-side dedup ships in the same release, so a standard
 * upgrade
 * deploys both the fast path and the client that understands it together.
 */

import type { Config } from '$config';
import type { BlurtClient, BlockHeader, ChainOperation } from '$blurt/client';
import type { Database } from '$db/pool';
import { extractSigner, parseJsonPayload, type CustomJsonOp } from '$blurt/verify';
import { checkJsonbSize } from '$indexer/payloadSize';
import { chatEventBus } from '$indexer/chatEventBus';
import { orderbookEventBus } from '$indexer/orderbookEventBus';
import { checkChatOrder, recipientHasReplied, hasVerifiedChat } from '$indexer/chatGates';
import { enqueueFeedbackPush } from '$indexer/feedbackPushEnqueue';
import { enqueueChatPush } from '$indexer/chatPushEnqueue';
import { logger } from '$log';

const log = logger('head-tailer');

/** Opt-in fast-path emit tracing. Same gate as the durable handler
 *  (MORPHIT_CHAT_DEBUG=1). Metadata only. Shows whether a head-block
 *  message is emitted to SSE subscribers or dropped by the block check. */
const CHAT_DEBUG = process.env.MORPHIT_CHAT_DEBUG === '1';
function tailerDbg(event: string, data: Record<string, unknown>): void {
	if (CHAT_DEBUG) log.info(event, data);
}

/** The one op id this tailer cares about. Kept as a local literal
 *  (not imported from the dispatcher) so this file has no dependency
 *  on the full handler-dispatch graph; the parity smoke asserts it
 *  matches OP_IDS.chatMessage. */
const CHAT_OP_ID = 'morphit_chat_v1';

/** v1.5.5 fastfeedback — the review op the tailer also watches. Same
 *  hardcoded-id reasoning as CHAT_OP_ID above (fast path, no cross-package
 *  import); the op-id parity smoke pins both against OP_IDS. */
const FEEDBACK_OP_ID = 'morphit_feedback_v1';

// ─── Validation constants — MUST match handlers/chat.ts ─────────────
// Duplicated deliberately (same rationale as the dispatcher↔frontend
// OP_IDS duplication): this file is on the latency-critical fast path
// and stays decoupled from the handler's DB-stateful machinery. The
// `head-tailer-validation-parity-smoke` asserts these three
// constants still match handlers/chat.ts so they can't silently drift.

/** Blurt account-name shape. Mirror of ACCOUNT_NAME_RE in handlers/chat.ts. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
/** Ciphertext hard cap. Mirror of MAX_CIPHERTEXT_CHARS in handlers/chat.ts. */
const MAX_CIPHERTEXT_CHARS = 1536;
/** base64 shape. Mirror of the ciphertext regex in handlers/chat.ts. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Upper bound on how many head blocks we scan in a single tick. If the
 *  tailer fell far behind (paused, slow RPC), we skip ahead rather than
 *  emit a huge burst — the skipped blocks' messages still arrive via the
 *  durable path. Keeps fast-path RPC + emit work bounded. */
const MAX_CATCHUP_BLOCKS = 120;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Extract a non-empty string `client_tag` from a message header, or
 *  null. Mirror of the client's clientTagFromHeader; the client dedupes
 *  on exactly this value.
 *
 *  EXPORTED (v1.5.5) so the SSE snapshot replay dedupes on the IDENTICAL rule
 *  rather than growing a second extractor that could drift from this one. */
export function clientTagFromHeader(header: unknown): string | null {
	if (!isPlainObject(header)) return null;
	const v = header.client_tag;
	return typeof v === 'string' && v.length > 0 ? v : null;
}

/** v1.7.0 (ADR-0051) — the two order ops the tailer watches.
 *
 *  ONLY these two, and the exclusions are a SAFETY boundary rather than a scope
 *  decision — read before adding a third:
 *
 *    - `morphit_order_v1` (new order) is EXCLUDED because the public orderbook
 *      gates on `fee_status IN ('verified','verified_by_attestation')`. A
 *      head-block order has not had its fee verified, and verification is money,
 *      which ADR-0051 keeps durable-only. Publishing one provisionally would let
 *      anyone put unpaid orders in front of every user for ~60s at a time — a fee
 *      bypass with extra steps. The person who POSTED an order sees it instantly
 *      anyway, client-side, via `pendingOrders` — which is what Ken actually asked
 *      for ("the order i just placed") and costs no such hole.
 *    - `morphit_order_replace_v1` (edit) is EXCLUDED because it carries the
 *      order's free text. A rejected edit would flash arbitrary content into every
 *      open orderbook for ~60s, repeatably.
 *
 *  What's left carries no free text at all — cancel is `{permlink}`, complete is
 *  `{permlink, counterparty}` — acts on an order that is ALREADY fee-verified and
 *  public, and is owner-signed (both durable handlers gate on
 *  `account = signer`). The worst a bogus one can do is make an order briefly
 *  vanish from live views and reappear on the next durable pass. */
const ORDER_CANCEL_OP_ID = 'morphit_order_cancel_v1';
const ORDER_COMPLETE_OP_ID = 'morphit_order_complete_v1';

/** An order status transition seen at head. */
interface LocatedOrderStatusOp {
	/** `account/permlink` — the id shape the durable handlers pass to
	 *  `recordOrderbookChange`, so both channels name the same order the same way. */
	readonly orderId: string;
	readonly kind: 'cancelled' | 'completed';
}

/**
 * Extract an order cancel/complete from a head-block op.
 *
 * The order id is `signer/permlink` because BOTH durable handlers are owner-only:
 * orderCancel runs `WHERE account = $1 AND permlink = $2` with `$1 = ctx.signer`,
 * and orderComplete's `account = signer` guard means only the owner can complete
 * their own listing. So a signer can only ever name an order they own — which is
 * also why this needs no ownership lookup of its own.
 *
 * PURE.
 */
function locateOrderStatusOp(op: ChainOperation): LocatedOrderStatusOp | null {
	const [opName, opBody] = op;
	if (opName !== 'custom_json') return null;
	const body = opBody as { id?: unknown; json?: unknown; required_posting_auths?: unknown } | null;
	if (!body) return null;

	const kind =
		body.id === ORDER_CANCEL_OP_ID
			? ('cancelled' as const)
			: body.id === ORDER_COMPLETE_OP_ID
				? ('completed' as const)
				: null;
	if (kind === null) return null;

	const auths = body.required_posting_auths;
	if (!Array.isArray(auths) || auths.length !== 1) return null;
	const signer = auths[0];
	if (typeof signer !== 'string' || !ACCOUNT_NAME_RE.test(signer)) return null;

	let payload: unknown;
	try {
		payload = typeof body.json === 'string' ? JSON.parse(body.json) : null;
	} catch {
		return null;
	}
	if (!isPlainObject(payload)) return null;

	const permlink = payload.permlink;
	// Shape-only. The durable handler is the authority on whether this permlink
	// names a real live order the signer owns; we're deciding whether to tell an
	// open orderbook "stop showing this", and being wrong there costs a row
	// blinking out and back at the next durable pass. Guarding against a
	// malformed string is enough; re-implementing the handler's validation here
	// would just be a second copy to drift.
	if (typeof permlink !== 'string' || permlink.length === 0 || permlink.length > 256) return null;

	return { orderId: `${signer}/${permlink}`, kind };
}

/** v1.5.5 — a feedback op located in a head block, narrowed to what the fast
 *  notification needs. */
interface LocatedFeedbackOp {
	readonly reviewer: string;
	readonly subject: string;
	readonly rating: number;
	readonly orderPermlink: string;
}

/**
 * Parse + shape-validate one custom_json op as a review. Returns null unless it
 * is a well-formed morphit_feedback_v1 the durable handler would also accept in
 * shape: named subject, 1-5 rating, a cited order.
 *
 * Shape only — admissibility (fee-verified order, provable counterparty, no
 * duplicate) is checked against the DB in fastFeedbackAllowed. Untethered
 * feedback (no order_permlink) is never fast-notified: the durable handler
 * drops it from reputation anyway, so notifying fast would advertise something
 * that doesn't count.
 */
function locateFeedbackOp(op: ChainOperation): LocatedFeedbackOp | null {
	const [opName, opBody] = op;
	if (opName !== 'custom_json') return null;
	const body = opBody as { id?: unknown; json?: unknown; required_posting_auths?: unknown } | null;
	if (!body || body.id !== FEEDBACK_OP_ID) return null;

	const auths = body.required_posting_auths;
	if (!Array.isArray(auths) || auths.length !== 1) return null;
	const reviewer = auths[0];
	if (typeof reviewer !== 'string' || !ACCOUNT_NAME_RE.test(reviewer)) return null;

	let payload: unknown;
	try {
		payload = typeof body.json === 'string' ? JSON.parse(body.json) : null;
	} catch {
		return null;
	}
	if (!isPlainObject(payload)) return null;

	const subject = payload.subject;
	if (typeof subject !== 'string' || !ACCOUNT_NAME_RE.test(subject)) return null;
	if (subject === reviewer) return null; // self-review; durable rejects

	const rating = payload.rating;
	if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
		return null;
	}

	const orderPermlink = payload.order_permlink;
	if (typeof orderPermlink !== 'string' || orderPermlink.length === 0) return null;

	return { reviewer, subject, rating, orderPermlink };
}

/** A chat op located in a head block, narrowed to what we emit. */
interface LocatedChatOp {
	readonly signer: string;
	readonly recipient: string;
	readonly ciphertext: string;
	readonly header: Record<string, unknown>;
	readonly clientTag: string;
	/** cp446 — the order this message is about (plaintext field on the op body),
	 *  or null. The inbox threads by it and the transcript filters on it, so a
	 *  fast-path message that arrived without it would surface in the wrong
	 *  discussion for the ~6s before the durable row replaced it. */
	readonly orderPermlink: string | null;
}

/**
 * Parse + shape-validate one custom_json op as a chat message. Returns
 * the located op when it is a well-formed, client-tag-carrying chat
 * message we could emit, or null to skip it (not a chat op, malformed,
 * wrong shape, or no client_tag). Pure — no DB, no I/O.
 *
 * The shape checks mirror the durable handler's intake validation so the
 * fast path emits (approximately) the same set the durable pass will
 * persist. It is deliberately NOT a superset: anything the handler would
 * reject on shape, we also reject here.
 */
function locateChatOp(op: ChainOperation): LocatedChatOp | null {
	const [opName, opBody] = op;
	if (opName !== 'custom_json') return null;
	const body = opBody as Partial<CustomJsonOp> | undefined;
	if (!body || body.id !== CHAT_OP_ID) return null;

	const customOp: CustomJsonOp = {
		required_auths: Array.isArray(body.required_auths) ? body.required_auths : [],
		required_posting_auths: Array.isArray(body.required_posting_auths)
			? body.required_posting_auths
			: [],
		id: body.id,
		json: typeof body.json === 'string' ? body.json : ''
	};

	const signerResult = extractSigner(customOp);
	if (!signerResult.ok) return null;
	const signer = signerResult.signer;

	const payload = parseJsonPayload(customOp);
	if (!isPlainObject(payload)) return null;

	const recipient = payload.recipient;
	if (typeof recipient !== 'string' || !ACCOUNT_NAME_RE.test(recipient)) return null;
	if (recipient === signer) return null;

	const ciphertext = payload.ciphertext;
	if (typeof ciphertext !== 'string') return null;
	if (ciphertext.length < 1 || ciphertext.length > MAX_CIPHERTEXT_CHARS) return null;
	if (!BASE64_RE.test(ciphertext)) return null;

	if (!isPlainObject(payload.header)) return null;
	// Same serialized-size gate the handler applies to the header jsonb.
	if (!checkJsonbSize(payload.header).ok) return null;

	// cp406 — mirror the handler's OPTIONAL sender self-copy bound
	// (handlers/chat.ts): self_ciphertext/self_nonce are a pair, and the
	// self-copy is capped exactly like the main ciphertext, so the fast path
	// never provisionally emits a message the durable handler would reject.
	const selfCiphertext = payload.header.self_ciphertext;
	const selfNonce = payload.header.self_nonce;
	if ((selfCiphertext !== undefined) !== (selfNonce !== undefined)) return null;
	if (selfCiphertext !== undefined) {
		if (typeof selfCiphertext !== 'string' || typeof selfNonce !== 'string') return null;
		if (selfCiphertext.length < 1 || selfCiphertext.length > MAX_CIPHERTEXT_CHARS) return null;
		if (!BASE64_RE.test(selfCiphertext) || !BASE64_RE.test(selfNonce)) return null;
	}

	// Client-tag gate (invariant 5): only emit dedupable messages.
	const clientTag = clientTagFromHeader(payload.header);
	if (clientTag === null) return null;

	// Shape-validate only. The DURABLE handler is the authority on whether this
	// permlink names a real order (validateChatOrderPermlink); the fast path just
	// forwards what the signer claimed, and the durable row corrects it if wrong.
	const rawPermlink = (payload as { order_permlink?: unknown }).order_permlink;
	const orderPermlink =
		typeof rawPermlink === 'string' && rawPermlink.length > 0 && rawPermlink.length <= 256
			? rawPermlink
			: null;

	return { signer, recipient, ciphertext, header: payload.header, clientTag, orderPermlink };
}

/** Status snapshot for /v1/health.
 *
 *  v1.7.0 — `enabled` was REMOVED with the config knob it reported (ADR-0051).
 *  A field that can only ever say `true` tells an operator nothing, and an
 *  operator who reads it once and believes fast is optional is worse off than
 *  one who never saw it. What they actually need to know is whether the tailer
 *  is RUNNING and how far behind it is — which `running` and `scannedHead`
 *  already say. */
export interface HeadTailerStatus {
	readonly running: boolean;
	/** Highest head block scanned so far (0 before the first tick). */
	readonly scannedHead: number;
	/** Messages emitted on the fast path since start. */
	readonly emitted: number;
	readonly lastError: string | null;
	readonly lastErrorAt: Date | null;
}

export class HeadTailer {
	private readonly abort = new AbortController();
	private scannedHead = 0;
	private emitted = 0;
	private running = false;
	private lastError: string | null = null;
	private lastErrorAt: Date | null = null;

	constructor(
		private readonly config: Config,
		private readonly db: Database,
		private readonly blurt: BlurtClient
	) {}

	getStatus(): HeadTailerStatus {
		return {
			running: this.running,
			scannedHead: this.scannedHead,
			emitted: this.emitted,
			lastError: this.lastError,
			lastErrorAt: this.lastErrorAt
		};
	}

	/** Drive the tailer loop. Fire-and-forget from main.ts; resolves on
	 *  stop().
	 *
	 *  v1.7.0 (ADR-0051) — there is no longer an enabled check here. The fast
	 *  path is unconditional: it never writes to the DB, so the worst it can
	 *  do is fail to make things fast, and nobody prefers slow. */
	async run(): Promise<void> {
		log.info('fastpath_start', { interval_ms: this.config.fastPathIntervalMs });
		this.running = true;

		// Initialise the watermark to the CURRENT head so we only tail
		// NEW blocks going forward. History + the LIB..head startup
		// window are covered by the SSE snapshot and the durable path;
		// backfilling here would just duplicate them (client dedupes
		// anyway, but there's no reason to spend the fetches).
		try {
			const dgp = await this.blurt.getDynamicGlobalProperties();
			this.scannedHead = dgp.head_block_number;
		} catch (err) {
			// Couldn't read the head at startup — start from 0 and let
			// the first successful tick establish the watermark (it will
			// skip-ahead via MAX_CATCHUP rather than scan from genesis).
			this.recordError(err);
		}

		while (!this.abort.signal.aborted) {
			await sleep(this.config.fastPathIntervalMs, this.abort.signal);
			if (this.abort.signal.aborted) break;
			try {
				await this.tick();
				this.lastError = null;
			} catch (err) {
				// Never let a bad tick escape — the durable poller must
				// stay unaffected. Log and retry next interval.
				this.recordError(err);
			}
		}

		this.running = false;
		log.info('fastpath_stopped');
	}

	/** One scan of the head delta. */
	private async tick(): Promise<void> {
		const dgp = await this.blurt.getDynamicGlobalProperties();
		const head = dgp.head_block_number;

		// First successful tick after a startup DGP failure: establish
		// the watermark without scanning back to genesis.
		if (this.scannedHead === 0) {
			this.scannedHead = head;
			return;
		}

		// Reorg / no-progress: head at or below our watermark. Snap the
		// watermark down to the new head (a shortened chain) and wait for
		// forward progress. We don't re-scan — durable is the source of
		// truth, and the client dedupes any message we re-emit later.
		if (head <= this.scannedHead) {
			if (head < this.scannedHead) {
				log.warn('head_regressed', { from: this.scannedHead, to: head });
				this.scannedHead = head;
			}
			return;
		}

		// Bound the catch-up: if we're far behind, skip ahead. The
		// skipped blocks' messages still arrive via the durable path.
		let from = this.scannedHead + 1;
		if (head - from + 1 > MAX_CATCHUP_BLOCKS) {
			const skipTo = head - MAX_CATCHUP_BLOCKS + 1;
			log.warn('fastpath_skip_ahead', { from, skip_to: skipTo, head });
			from = skipTo;
		}

		for (let n = from; n <= head && !this.abort.signal.aborted; n++) {
			const block = await this.blurt.getBlock(n);
			if (!block) {
				// Node hasn't served this head block yet — stop this tick
				// at the last contiguous block we DID scan, and retry the
				// gap next interval. Advancing the watermark past a hole
				// would silently drop that block's messages from the fast
				// path (they'd still arrive durably, but we prefer not to).
				this.scannedHead = n - 1;
				return;
			}
			await this.scanBlock(block);
			this.scannedHead = n;
		}
	}

	/** Extract, validate, block-check, and emit chat ops from one block. */
	private async scanBlock(block: BlockHeader): Promise<void> {
		// Head-block timestamps are UTC; normalise like the dispatcher.
		const createdAt = new Date(block.timestamp + (block.timestamp.endsWith('Z') ? '' : 'Z'));

		for (let ti = 0; ti < block.transactions.length; ti++) {
			const trx = block.transactions[ti];
			if (!trx) continue;
			for (const op of trx.operations) {
				if (!op) continue;

				// v1.5.5 fastfeedback — Ken: "kentest2 left a 4-star feedback for
				// kentest3, but kentest3 did not get a notification at all (let
				// alone within 6 seconds)". Only chat had a head-block path, so a
				// review notification could never beat the durable ~60s. Same
				// shape as the chat fast path: a strict SUBSET of durable
				// admission, deduped with the durable enqueue on the trx id.
				// v1.7.0 (ADR-0051) — order status transitions seen at head. Emit
				// only; the durable poller remains the sole writer. See
				// locateOrderStatusOp for why exactly two op ids qualify.
				const orderOp = locateOrderStatusOp(op);
				if (orderOp !== null) {
					orderbookEventBus.emitProvisional({ orderId: orderOp.orderId, kind: orderOp.kind });
					this.emitted++;
					tailerDbg('tailer.EMIT.orderStatus', { order: orderOp.orderId, kind: orderOp.kind });
					continue;
				}

				const feedbackOp = locateFeedbackOp(op);
				if (feedbackOp !== null) {
					const trxIdFb = block.transaction_ids[ti];
					if (trxIdFb !== undefined) {
						await this.maybeFastFeedbackNotify(feedbackOp, trxIdFb, createdAt);
					}
					continue;
				}

				const located = locateChatOp(op);
				if (located === null) continue;

				// Invariant 4: enforce the block list (recipient blocked
				// sender → drop). Same query the durable handler runs.
				let blocked: boolean;
				try {
					blocked = await this.recipientBlockedSender(located.recipient, located.signer);
				} catch (err) {
					// A block-check DB failure must FAIL CLOSED for the
					// fast path — if we can't confirm the sender isn't
					// blocked, we don't emit (the durable path will
					// deliver it once irreversible, with its own check).
					log.warn('block_check_failed', {}, err);
					tailerDbg('tailer.DROP.blockCheckFailed', {
						sender: located.signer,
						recipient: located.recipient
					});
					continue;
				}
				if (blocked) {
					tailerDbg('tailer.DROP.blocked', {
						sender: located.signer,
						recipient: located.recipient
					});
					continue;
				}

				const lo = located.signer < located.recipient ? located.signer : located.recipient;
				const hi = located.signer < located.recipient ? located.recipient : located.signer;
				// cp471/v1.5.5 — evaluate the SAFE-SUBSET gate ONCE, here, and use
				// the single answer for BOTH the fast Web Push and whether this
				// event may be replayed into a later-opened chatroom. Two
				// independent evaluations of "is this sender established?" is
				// exactly the drift chatGates.ts exists to prevent.
				const trxId = block.transaction_ids[ti];
				const fastAllowed = await this.fastNotifyAllowed(located, createdAt);
				tailerDbg('tailer.EMIT', {
					sender: located.signer,
					recipient: located.recipient,
					order: located.orderPermlink ?? null,
					replayable: fastAllowed
				});
				chatEventBus.emitFast({
					lo,
					hi,
					sender: located.signer,
					recipient: located.recipient,
					ciphertext: located.ciphertext,
					header: located.header,
					createdAt,
					clientTag: located.clientTag,
					orderPermlink: located.orderPermlink,
					// Ungated messages still stream LIVE to an open chatroom (as
					// they always have); they're just never replayed into a fresh
					// snapshot, since the durable path may still reject them.
					replayable: fastAllowed
				});
				this.emitted++;

				// cp471 — fast Web Push for this (already block-passed) message.
				// Gated to a SAFE SUBSET of durable admission so a first-contact
				// stranger is never fast-notified.
				if (fastAllowed && trxId !== undefined) {
					await this.maybeFastNotify(located, trxId, createdAt);
				}
			}
		}
	}

	/** cp471/v1.5.5 — the SAFE-SUBSET gate, evaluated ONCE per message.
	 *
	 *  True iff this already-block-passed message is clearly allowed: the order
	 *  tag (if any) names a real order owned by a party, AND either the two have
	 *  an established conversation or this is a response to the recipient's live
	 *  order. A strict SUBSET of durable admission — a first-contact stranger
	 *  (whom the durable stranger-fee gate would gate) never passes, so neither
	 *  the fast push nor snapshot replay can become a spam vector.
	 *
	 *  Extracted in v1.5.5 because the answer now drives TWO things — the push
	 *  AND replayability — and evaluating "is this sender established?" twice is
	 *  how the two silently drift apart. Non-fatal: on error, deny (the durable
	 *  path still delivers, just at its own pace). */
	private async fastNotifyAllowed(located: LocatedChatOp, createdAt: Date): Promise<boolean> {
		try {
			let orderResponseBypass = false;
			if (located.orderPermlink !== null) {
				const oc = await checkChatOrder(this.db, {
					permlink: located.orderPermlink,
					recipient: located.recipient,
					signer: located.signer,
					blockTime: createdAt
				});
				// A tag naming no real owned order → the durable REJECTS the
				// message (order_permlink_not_found). Never fast-path it.
				if (!oc.found) return false;
				orderResponseBypass = oc.ownedByRecipient && oc.live;
			}
			const recipientReplied = await recipientHasReplied(this.db, {
				recipient: located.recipient,
				sender: located.signer
			});
			// A genuine two-way conversation (the recipient has replied) OR a
			// response to the recipient's own live order = safe.
			return recipientReplied || orderResponseBypass;
		} catch (err) {
			log.warn('fast_gate_failed', {
				recipient: located.recipient,
				err: String((err as Error)?.message ?? err)
			});
			return false;
		}
	}

	/** cp471 — enqueue a fast chat Web Push for an already-block-passed message
	 *  whose safe-subset gate has ALREADY passed (see fastNotifyAllowed — the
	 *  caller evaluates it once and shares the answer with snapshot replay).
	 *  Dedup on the trx id collapses this with the durable enqueue to exactly
	 *  one notification. Non-fatal. */
	private async maybeFastNotify(
		located: LocatedChatOp,
		trxId: string,
		createdAt: Date
	): Promise<void> {
		try {
			await enqueueChatPush(this.db, {
				recipient: located.recipient,
				sender: located.signer,
				orderPermlink: located.orderPermlink,
				sourceTrxId: trxId,
				eventAt: createdAt
			});
		} catch (err) {
			log.warn('fast_notify_failed', {
				recipient: located.recipient,
				err: String((err as Error)?.message ?? err)
			});
		}
	}

	/** v1.5.5 fastfeedback — notify a review's SUBJECT within ~5s instead of the
	 *  durable ~60s.
	 *
	 *  GATED to a strict SUBSET of durable admission, for the same reason the
	 *  chat fast path is: anyone can broadcast a `morphit_feedback_v1` op, and
	 *  the durable handler will happily reject it — but a notification already
	 *  sent cannot be recalled. Without a gate, a stranger could spam review
	 *  notifications with ops that never index. So we re-check, cheaply, the
	 *  three things that actually decide admission:
	 *
	 *    1. the cited order exists, is owned by one of the two parties, and its
	 *       listing fee is VERIFIED — the economic cost that makes a fake review
	 *       expensive;
	 *    2. the pair clears the PROVABLE-COUNTERPARTY bar (shared impl in
	 *       chatGates — the same one the durable handler and order-completion
	 *       use); and
	 *    3. no review already exists for (reviewer, subject, order) — otherwise
	 *       a re-broadcast the durable path rejects as duplicate would still
	 *       fire a fresh notification.
	 *
	 *  Anything the durable handler additionally rejects (comment charset,
	 *  length) only costs a notification for a review that then doesn't appear —
	 *  bounded, and only reachable by an established counterparty paying an op
	 *  fee per attempt.
	 *
	 *  Non-fatal: on any error we simply don't fast-notify; the durable handler
	 *  still enqueues, deduped on the same trx id. */
	private async maybeFastFeedbackNotify(
		fb: LocatedFeedbackOp,
		trxId: string,
		createdAt: Date
	): Promise<void> {
		try {
			const allowed = await this.fastFeedbackAllowed(fb, createdAt);
			if (!allowed) return;
			await enqueueFeedbackPush(this.db, {
				subject: fb.subject,
				reviewer: fb.reviewer,
				rating: fb.rating,
				sourceTrxId: trxId,
				eventAt: createdAt
			});
		} catch (err) {
			log.warn('fast_feedback_notify_failed', {
				subject: fb.subject,
				err: String((err as Error)?.message ?? err)
			});
		}
	}

	/** The strict-subset admission check for fastfeedback. See
	 *  maybeFastFeedbackNotify for the rationale. */
	private async fastFeedbackAllowed(fb: LocatedFeedbackOp, createdAt: Date): Promise<boolean> {
		// 1. Fee-verified order citation owned by one of the two parties. Same
		//    shape as the durable handler's citation gate.
		const ord = await this.db.query<{ ok: boolean }>(
			`SELECT EXISTS (
			   SELECT 1 FROM orders
			    WHERE permlink = $1
			      AND account IN ($2, $3)
			      AND fee_status IN ('verified', 'verified_by_attestation')
			 ) AS ok`,
			[fb.orderPermlink, fb.subject, fb.reviewer]
		);
		if (ord.rows[0]?.ok !== true) return false;

		// 3. Duplicate — a re-broadcast the durable path rejects must not
		//    re-notify. (Checked before the heavier conformance query.)
		const dup = await this.db.query<{ exists: boolean }>(
			`SELECT EXISTS (
			   SELECT 1 FROM feedback
			    WHERE reviewer = $1 AND subject = $2 AND order_permlink = $3
			 ) AS exists`,
			[fb.reviewer, fb.subject, fb.orderPermlink]
		);
		if (dup.rows[0]?.exists === true) return false;

		// 2. The provable-counterparty bar — ONE shared implementation with the
		//    durable review gate and order-completion (chatGates), so the fast
		//    path can never quietly admit what the durable path refuses.
		return hasVerifiedChat(this.db, {
			a: fb.reviewer,
			b: fb.subject,
			asOf: createdAt
		});
	}

	/** SAME block-list check the durable chat handler runs. Returns true
	 *  when `recipient` has an active block against `sender`. */
	private async recipientBlockedSender(recipient: string, sender: string): Promise<boolean> {
		const res = await this.db.query<{ exists: boolean }>(
			`SELECT EXISTS (
			   SELECT 1 FROM blocks
			    WHERE blocker = $1 AND blocked = $2 AND state = 'blocked'
			 ) AS exists`,
			[recipient, sender]
		);
		return res.rows[0]?.exists === true;
	}

	private recordError(err: unknown): void {
		this.lastError = err instanceof Error ? err.message : String(err);
		this.lastErrorAt = new Date();
		log.warn('tick_failed', {}, err);
	}

	/** Ask the loop to stop at the next safe boundary. */
	stop(): void {
		this.abort.abort();
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}
