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
 * ON BY DEFAULT (config.chatFastPathEnabled, ADR-0048). `run()` returns
 * immediately when an operator has explicitly disabled it. The matching
 * client-side dedup ships in the same release, so a standard upgrade
 * deploys both the fast path and the client that understands it together.
 */

import type { Config } from '$config';
import type { BlurtClient, BlockHeader, ChainOperation } from '$blurt/client';
import type { Database } from '$db/pool';
import { extractSigner, parseJsonPayload, type CustomJsonOp } from '$blurt/verify';
import { checkJsonbSize } from '$indexer/payloadSize';
import { chatEventBus } from '$indexer/chatEventBus';
import { logger } from '$log';

const log = logger('chat-head-tailer');

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

// ─── Validation constants — MUST match handlers/chat.ts ─────────────
// Duplicated deliberately (same rationale as the dispatcher↔frontend
// OP_IDS duplication): this file is on the latency-critical fast path
// and stays decoupled from the handler's DB-stateful machinery. The
// `chat-head-tailer-validation-parity-smoke` asserts these three
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
 *  on exactly this value. */
function clientTagFromHeader(header: unknown): string | null {
	if (!isPlainObject(header)) return null;
	const v = header.client_tag;
	return typeof v === 'string' && v.length > 0 ? v : null;
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

/** Status snapshot for /v1/health. */
export interface ChatHeadTailerStatus {
	readonly enabled: boolean;
	readonly running: boolean;
	/** Highest head block scanned so far (0 before the first tick). */
	readonly scannedHead: number;
	/** Messages emitted on the fast path since start. */
	readonly emitted: number;
	readonly lastError: string | null;
	readonly lastErrorAt: Date | null;
}

export class ChatHeadTailer {
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

	getStatus(): ChatHeadTailerStatus {
		return {
			enabled: this.config.chatFastPathEnabled,
			running: this.running,
			scannedHead: this.scannedHead,
			emitted: this.emitted,
			lastError: this.lastError,
			lastErrorAt: this.lastErrorAt
		};
	}

	/** Drive the tailer loop. Fire-and-forget from main.ts; resolves on
	 *  stop(). No-op (returns immediately) when the fast path is
	 *  disabled. */
	async run(): Promise<void> {
		if (!this.config.chatFastPathEnabled) {
			log.info('fastpath_disabled');
			return;
		}
		log.info('fastpath_enabled', { interval_ms: this.config.chatFastPathIntervalMs });
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
			await sleep(this.config.chatFastPathIntervalMs, this.abort.signal);
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

		for (const trx of block.transactions) {
			if (!trx) continue;
			for (const op of trx.operations) {
				if (!op) continue;
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
				tailerDbg('tailer.EMIT', {
					sender: located.signer,
					recipient: located.recipient,
					order: located.orderPermlink ?? null
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
					orderPermlink: located.orderPermlink
				});
				this.emitted++;
			}
		}
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
