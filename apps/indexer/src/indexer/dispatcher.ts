/**
 * Morphit indexer — dispatcher.
 *
 * Given a block, iterate every transaction's every operation, pluck
 * out the morphit-flavoured custom_json ops, and route each to its
 * handler. Writes to the event-log table in the same transaction
 * the handler runs in, so materialised state and audit trail stay
 * in lockstep.
 *
 * Error-containment rules:
 *   - Handler returns `{ ok: false, reason }`     → log rejection,
 *                                                   continue block
 *   - Handler throws unexpectedly                  → log rejection
 *                                                   with reason
 *                                                   'handler_threw',
 *                                                   continue block.
 *                                                   The block's
 *                                                   transaction
 *                                                   stays intact.
 *   - Dispatcher itself fails (DB error, etc.)     → bubbles up,
 *                                                   poller rolls
 *                                                   back the block
 *                                                   and retries
 *
 * This means a single buggy handler or malformed payload never
 * wedges the indexer.
 */

import type pg from 'pg';

import type { BlockHeader, BlockTransaction, BlurtClient, ChainOperation } from '$blurt/client';
import type { Config } from '$config';
import { extractSigner, parseJsonPayload, type CustomJsonOp } from '$blurt/verify';
import type { Handler, OpContext } from '$indexer/handler-contract';
import { parseBlurtAmount, parseMemoPermlink } from '$indexer/fee-transfer';

import profileHandler from '$indexer/handlers/profile';
import orderHandler from '$indexer/handlers/order';
import orderReplaceHandler from '$indexer/handlers/orderReplace';
import orderCancelHandler from '$indexer/handlers/orderCancel';
import orderCompleteHandler from '$indexer/handlers/orderComplete';
import feedbackHandler from '$indexer/handlers/feedback';
import feedbackResponseHandler from '$indexer/handlers/feedbackResponse';
import chatHandler from '$indexer/handlers/chat';
import chatIdentityHandler from '$indexer/handlers/chatIdentity';
import chatReadHandler from '$indexer/handlers/chatRead';
import chatFoldersHandler from '$indexer/handlers/chatFolders';
import settingsHandler from '$indexer/handlers/settings';
import releaseHandler from '$indexer/handlers/release';
import feeAttestHandler from '$indexer/handlers/feeAttest';
import featureBidHandler from '$indexer/handlers/featureBid';
import operatorRegisterHandler from '$indexer/handlers/operatorRegister';
import operatorBlockHandler from '$indexer/handlers/operatorBlock';
import operatorPaymentMethodHandler from '$indexer/handlers/operatorPaymentMethod';
import blockHandler from '$indexer/handlers/block';
import strangerFeeHandler from '$indexer/handlers/strangerFee';

// ─── Op ID constants ────────────────────────────────────────────────
// Mirrors $net/config.OP_IDS in the frontend. Duplicated deliberately —
// the indexer and frontend are independently deployable; if they
// diverge, it's a controlled schema migration, not a typo.
export const OP_IDS = {
	profile: 'morphit_profile_v1',
	order: 'morphit_order_v1',
	orderReplace: 'morphit_order_replace_v1',
	orderCancel: 'morphit_order_cancel_v1',
	orderComplete: 'morphit_order_complete_v1',
	feedback: 'morphit_feedback_v1',
	feedbackResponse: 'morphit_feedback_response_v1',
	chatMessage: 'morphit_chat_v1',
	chatIdentity: 'morphit_chat_identity_v1',
	chatRead: 'morphit_chat_read_v1',
	chatFolders: 'morphit_chat_folders_v1',
	settings: 'morphit_settings_v1',
	releaseDiscovery: 'morphit_release_v1',
	feeAttest: 'morphit_fee_attest_v1',
	featureBid: 'morphit_feature_bid_v1',
	operatorRegister: 'morphit_operator_register_v1',
	/** ADR-0018: operator-instance block.  The operator account
	 *  signs this op to mark a user as blocked on this instance.
	 *  The blocked user's listings are filtered out of the
	 *  operator's orderbook view; the user can still operate
	 *  unaffected on other instances. */
	operatorBlock: 'morphit_operator_block_v1',
	/** ADR-0021: operator-instance payment-method addition.
	 *  Operators broadcast region-specific payment methods that
	 *  augment (but cannot override or remove) the canonical
	 *  registry.  Keys are stored on chain in the order's
	 *  `payment_methods` array prefixed `@instance:` so cross-
	 *  instance filtering can detect them. */
	operatorPaymentMethod: 'morphit_payment_method_addition_v1',
	block: 'morphit_block_v1',
	strangerFee: 'morphit_stranger_fee_v1'
} as const;

/** Map from op_id string to the handler that processes it. Every
 *  known op id is registered; unknown ids land as
 *  `handler_not_implemented` rejections (see below). */
const HANDLERS: Readonly<Record<string, Handler>> = {
	[OP_IDS.profile]: profileHandler,
	[OP_IDS.order]: orderHandler,
	[OP_IDS.orderReplace]: orderReplaceHandler,
	[OP_IDS.orderCancel]: orderCancelHandler,
	[OP_IDS.orderComplete]: orderCompleteHandler,
	[OP_IDS.feedback]: feedbackHandler,
	[OP_IDS.feedbackResponse]: feedbackResponseHandler,
	[OP_IDS.chatMessage]: chatHandler,
	[OP_IDS.chatIdentity]: chatIdentityHandler,
	[OP_IDS.chatRead]: chatReadHandler,
	[OP_IDS.chatFolders]: chatFoldersHandler,
	[OP_IDS.settings]: settingsHandler,
	[OP_IDS.releaseDiscovery]: releaseHandler,
	[OP_IDS.feeAttest]: feeAttestHandler,
	[OP_IDS.featureBid]: featureBidHandler,
	[OP_IDS.operatorRegister]: operatorRegisterHandler,
	[OP_IDS.operatorBlock]: operatorBlockHandler,
	[OP_IDS.operatorPaymentMethod]: operatorPaymentMethodHandler,
	[OP_IDS.block]: blockHandler,
	[OP_IDS.strangerFee]: strangerFeeHandler
};

const KNOWN_OP_IDS: ReadonlySet<string> = new Set(Object.values(OP_IDS));

// ─── Event-log write ────────────────────────────────────────────────

interface LogRow {
	readonly blockNum: number;
	readonly trxInBlock: number;
	readonly opInTrx: number;
	readonly blockTime: Date;
	readonly trxId: string;
	readonly signer: string;
	readonly opId: string;
	readonly payload: unknown;
	readonly status: 'applied' | 'rejected';
	readonly rejectReason: string | null;
}

async function writeEventLog(client: pg.PoolClient, row: LogRow): Promise<void> {
	await client.query(
		`INSERT INTO ops (
			block_num, trx_in_block, op_in_trx, block_time,
			trx_id, signer, op_id, payload, status, reject_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
		ON CONFLICT (block_num, trx_in_block, op_in_trx) DO NOTHING`,
		[
			row.blockNum,
			row.trxInBlock,
			row.opInTrx,
			row.blockTime,
			row.trxId,
			row.signer,
			row.opId,
			JSON.stringify(row.payload),
			row.status,
			row.rejectReason
		]
	);
}

// ─── Op extraction from block shape ────────────────────────────────

interface MorphitOpLocation {
	readonly trxInBlock: number;
	readonly opInTrx: number;
	readonly trxId: string;
	readonly op: CustomJsonOp;
	/** All operations in this transaction, in original order.
	 *  Passed into OpContext.siblingOps so handlers can correlate
	 *  with non-morphit Blurt ops (e.g. transfer). */
	readonly siblingOps: readonly ChainOperation[];
}

/** Parsed representation of a BLURT transfer to the fee-collection
 *  account. The block walk produces one of these for every such
 *  transfer it sees, regardless of whether a matching order exists. */
interface FeeTransferRow {
	readonly blockNum: number;
	readonly trxInBlock: number;
	readonly opInTrx: number;
	readonly blockTime: Date;
	readonly trxId: string;
	readonly sender: string;
	readonly amountBlurt: number;
	readonly memo: string;
	/** Parsed permlink from `morphit-fee:<permlink>` memos; null if
	 *  the memo doesn't follow the expected format. */
	readonly memoPermlink: string | null;
}

/** Walk a block for BLURT transfers targeting the fee-collection
 *  account. Returns a list ready for bulk insert into fee_transfers. */
function collectFeeTransfers(
	block: BlockHeader,
	blockNum: number,
	blockTime: Date,
	trxIds: readonly string[],
	feeRecipient: string
): FeeTransferRow[] {
	const out: FeeTransferRow[] = [];
	for (let ti = 0; ti < block.transactions.length; ti++) {
		const trx = block.transactions[ti];
		if (!trx) continue;
		for (let oi = 0; oi < trx.operations.length; oi++) {
			const op = trx.operations[oi];
			if (!op) continue;
			const [opName, body] = op;
			if (opName !== 'transfer') continue;
			const b = body as {
				from?: unknown;
				to?: unknown;
				amount?: unknown;
				memo?: unknown;
			};
			if (b.to !== feeRecipient) continue;
			if (typeof b.from !== 'string') continue;

			// amount parsing: accept malformed amounts but record them
			// so operators can see "something sent us a weird transfer".
			const amountNum = parseBlurtAmount(b.amount);
			const memoStr = typeof b.memo === 'string' ? b.memo : '';

			out.push({
				blockNum,
				trxInBlock: ti,
				opInTrx: oi,
				blockTime,
				trxId: trxIds[ti] ?? '',
				sender: b.from,
				// If the amount is malformed we use 0 so the numeric
				// column accepts the row. The memo_permlink stays
				// null too, so the order handler won't match it.
				amountBlurt: amountNum ?? 0,
				memo: memoStr,
				memoPermlink: parseMemoPermlink(memoStr)
			});
		}
	}
	return out;
}

/** Bulk-insert fee transfer rows. Called once per block before the
 *  morphit-op dispatch loop runs, so the order handler can see the
 *  fee_transfers table populated when it queries it. */
async function writeFeeTransfers(
	client: pg.PoolClient,
	rows: readonly FeeTransferRow[]
): Promise<void> {
	if (rows.length === 0) return;
	// One INSERT per row. Blocks rarely have more than a handful of
	// fee transfers; multi-row VALUES would micro-optimize, but the
	// loop is clearer and pg's prepared-statement cache amortizes.
	// ON CONFLICT because the unique triple (block, trx_in_block,
	// op_in_trx) could collide on poller retry.
	for (const r of rows) {
		await client.query(
			`INSERT INTO fee_transfers (
				block_num, trx_in_block, op_in_trx, block_time,
				trx_id, sender, amount_blurt, memo, memo_permlink
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (block_num, trx_in_block, op_in_trx) DO NOTHING`,
			[
				r.blockNum,
				r.trxInBlock,
				r.opInTrx,
				r.blockTime,
				r.trxId,
				r.sender,
				r.amountBlurt,
				r.memo,
				r.memoPermlink
			]
		);
	}
}

/** Accounts-table row for a newly observed account_create op.
 *  Signal A consumes these. */
interface AccountCreateRow {
	readonly newAccountName: string;
	readonly creator: string;
	readonly blockNum: number;
	readonly blockTime: Date;
	readonly trxId: string;
	/** Primary posting public key from the account_create op's posting
	 *  authority, or null if unparseable. Stored for display (the
	 *  truncated "(BLT…)" on order cards) — NOT used for verification. */
	readonly postingPubkey: string | null;
}

/** The three account-creation op names on Blurt. All three carry
 *  the new-account name and the creator. Their payload shapes
 *  differ slightly but the two fields we care about (`new_account_name`
 *  or `name`, and `creator`) follow consistent conventions. */
const ACCOUNT_CREATE_OPS = new Set([
	'account_create',
	'account_create_with_delegation',
	'create_claimed_account'
]);

/** Walk a block for account_create-family ops and produce rows
 *  for the accounts table. Non-account-create ops are skipped. */
function collectAccountCreates(
	block: BlockHeader,
	blockNum: number,
	blockTime: Date,
	trxIds: readonly string[]
): AccountCreateRow[] {
	const out: AccountCreateRow[] = [];
	for (let ti = 0; ti < block.transactions.length; ti++) {
		const trx = block.transactions[ti];
		if (!trx) continue;
		for (const op of trx.operations) {
			if (!op) continue;
			const [opName, body] = op;
			if (!ACCOUNT_CREATE_OPS.has(opName)) continue;
			const b = body as {
				new_account_name?: unknown;
				name?: unknown;
				creator?: unknown;
				posting?: { key_auths?: unknown };
			};
			// Different op variants use different field names; pick
			// whichever is present.
			const newName =
				typeof b.new_account_name === 'string'
					? b.new_account_name
					: typeof b.name === 'string'
						? b.name
						: null;
			if (!newName) continue;
			if (typeof b.creator !== 'string') continue;

			// Primary posting pubkey from the op's posting authority:
			// key_auths is [[pubkey, weight], ...]. Store the first key
			// for display only. Defensive parse — never throws on a
			// malformed/absent authority (just yields null).
			let postingPubkey: string | null = null;
			const ka = b.posting?.key_auths;
			if (Array.isArray(ka) && Array.isArray(ka[0]) && typeof ka[0][0] === 'string') {
				postingPubkey = ka[0][0];
			}

			out.push({
				newAccountName: newName,
				creator: b.creator,
				blockNum,
				blockTime,
				trxId: trxIds[ti] ?? '',
				postingPubkey
			});
		}
	}
	return out;
}

/** Bulk-insert account rows. ON CONFLICT only fills a NULL
 *  posting_pubkey (COALESCE keeps any value we already have),
 *  otherwise does nothing — so (a) the poller may retry a block,
 *  and (b) re-observing an account can backfill a posting key we
 *  hadn't captured, without disturbing the first-observed create
 *  metadata. */
async function writeAccountCreates(
	client: pg.PoolClient,
	rows: readonly AccountCreateRow[]
): Promise<void> {
	if (rows.length === 0) return;
	for (const r of rows) {
		await client.query(
			`INSERT INTO accounts (
				name, creator, created_block_num, created_block_time,
				created_trx_id, posting_pubkey
			) VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (name) DO UPDATE SET
				posting_pubkey = COALESCE(accounts.posting_pubkey, EXCLUDED.posting_pubkey)`,
			[r.newAccountName, r.creator, r.blockNum, r.blockTime, r.trxId, r.postingPubkey]
		);
	}
}

/** Update first_activity_at for an account if it's not already set.
 *  Called once per morphit-op by the dispatcher loop after a
 *  successful handler invocation. The UPDATE only affects rows
 *  where first_activity_at IS NULL, so repeated calls for the
 *  same account are no-ops. Accounts we don't have a row for
 *  (created before startBlock) are ignored. */
async function markFirstActivity(
	client: pg.PoolClient,
	account: string,
	blockTime: Date
): Promise<void> {
	await client.query(
		`UPDATE accounts
		 SET first_activity_at = $2
		 WHERE name = $1 AND first_activity_at IS NULL`,
		[account, blockTime]
	);
}

/** Walk a block, collect every custom_json op with a morphit id.
 *  Ignores non-custom_json ops and custom_json ops with other ids —
 *  those are not Morphit's business. */
function collectMorphitOps(block: BlockHeader, trxIds: readonly string[]): MorphitOpLocation[] {
	const out: MorphitOpLocation[] = [];
	const transactions = block.transactions;
	for (let ti = 0; ti < transactions.length; ti++) {
		const trx = transactions[ti] as BlockTransaction | undefined;
		if (!trx) continue;
		const ops = trx.operations;
		for (let oi = 0; oi < ops.length; oi++) {
			const op = ops[oi];
			if (!op) continue;
			const [opName, opBody] = op;
			if (opName !== 'custom_json') continue;
			const body = opBody as Partial<CustomJsonOp> | undefined;
			if (!body || typeof body.id !== 'string') continue;
			if (!KNOWN_OP_IDS.has(body.id)) continue;
			// Structural narrowing — CustomJsonOp requires the four
			// fields. If any is missing, we can't process; log the
			// rejection below.
			out.push({
				trxInBlock: ti,
				opInTrx: oi,
				trxId: trxIds[ti] ?? '',
				siblingOps: ops,
				op: {
					required_auths: Array.isArray(body.required_auths) ? body.required_auths : [],
					required_posting_auths: Array.isArray(body.required_posting_auths)
						? body.required_posting_auths
						: [],
					id: body.id,
					json: typeof body.json === 'string' ? body.json : ''
				}
			});
		}
	}
	return out;
}

// ─── Per-block dispatch ────────────────────────────────────────────

/** Apply every morphit op in a block. Called inside a DB transaction
 *  the caller owns (the poller's per-block tx). Individual handler
 *  rejections are logged and swallowed; only unexpected exceptions
 *  bubble up (and get rolled back by the caller). */
export async function applyBlock(
	client: pg.PoolClient,
	blockNum: number,
	block: BlockHeader,
	blurt: BlurtClient,
	config: Config,
	feeVerifiers: OpContext['feeVerifiers'],
	/** Part 106 — canonical expected fee amounts.  Threaded
	 *  through to OpContext so the order handler enforces the
	 *  chain-pinned amount (with env fallback) instead of
	 *  reading directly from config.  See handler-contract.ts
	 *  for the rationale. */
	feeAmounts: OpContext['feeAmounts'],
	/** FX-aware first-order floor converter — threaded through to
	 *  OpContext so the order handler can convert amount_min (in the
	 *  order's fiat) to USD before the $1 first-buy check.  See
	 *  handler-contract.ts. */
	fiatToUsd: OpContext['fiatToUsd']
): Promise<{
	applied: number;
	rejected: number;
	skipped: number;
	orderbookChanges: readonly string[];
	chatChanges: readonly { lo: string; hi: string; messageId: number }[];
}> {
	const blockTime = new Date(block.timestamp + (block.timestamp.endsWith('Z') ? '' : 'Z'));

	// Pre-pass: record every observed BLURT transfer to the fee-
	// collection account. Populates `fee_transfers` for audit and
	// for the Sybil-counting query (even though the order handler
	// itself reads from siblingOps for the per-order fee check).
	const feeRows = collectFeeTransfers(
		block,
		blockNum,
		blockTime,
		block.transaction_ids,
		config.feeRecipient
	);
	await writeFeeTransfers(client, feeRows);

	// Pre-pass: record every observed account_create op (and its
	// variants). Populates `accounts` so Signal A can find pairs
	// of accounts sharing a creator — ADR-0009 §5. Accounts whose
	// creation predates our startBlock never get a row, which is
	// fine — Signal A's focus is on *new* accounts.
	const accountRows = collectAccountCreates(block, blockNum, blockTime, block.transaction_ids);
	await writeAccountCreates(client, accountRows);

	// Phase E — per-block collector for orderbook-change
	// notifications.  Handlers that mutate orderbook-relevant
	// state (order, orderReplace, orderCancel, feeAttest)
	// call ctx.recordOrderbookChange(orderId).  The
	// dispatcher returns the accumulated set; the poller
	// emits them on the orderbook event bus AFTER the block
	// transaction commits, so SSE subscribers don't see
	// phantom events from rolled-back ops.
	const orderbookChanges = new Set<string>();

	// Phase E.5 — per-block collector for chat-message
	// notifications.  The chat handler calls ctx.recordChatChange
	// after a successful INSERT.  Each entry carries the
	// canonical conversation pair (LEAST/GREATEST) plus the
	// inserted message id, so SSE subscribers can filter without
	// a DB lookup.  Same post-commit emission discipline as
	// orderbook changes.
	const chatChanges: { lo: string; hi: string; messageId: number }[] = [];

	const located = collectMorphitOps(block, block.transaction_ids);

	// Per Finding A9: stable-sort located ops so admission-
	// affecting ops (block_v1, stranger_fee_v1) run before
	// admission-consuming ops (chat_v1).  Without this, a same-
	// block race where the user pays a stranger-fee in tx_A and
	// broadcasts the chat in tx_B can land tx_B before tx_A —
	// chat handler runs first, sees no stranger_fees row yet,
	// rejects with `stranger_fee_required`.  The user paid the
	// fee but their first message is silently dropped.
	//
	// Three priority classes:
	//   0 = admission-affecting (block_v1, stranger_fee_v1)
	//   1 = everything else (the default)
	//
	// Stable sort preserves (trxInBlock, opInTrx) order within
	// each class, so escalation between multiple stranger-fees
	// from the same sender in one block still applies correctly,
	// and a block_v1/unblock_v1 pair from the same user in one
	// block honors chronological order.
	const ADMISSION_OP_IDS: ReadonlySet<string> = new Set([OP_IDS.block, OP_IDS.strangerFee]);
	function priority(opId: string): number {
		return ADMISSION_OP_IDS.has(opId) ? 0 : 1;
	}
	// Array.prototype.sort is stable per ES2019.  Decorating with
	// the original index would also work, but the spec already
	// guarantees stability, and we trust the runtime here.
	const orderedLocated = [...located].sort((a, b) => priority(a.op.id) - priority(b.op.id));

	let applied = 0;
	let rejected = 0;
	const skipped = 0;

	for (const entry of orderedLocated) {
		const { trxInBlock, opInTrx, trxId, op, siblingOps } = entry;

		// Step 1: extract signer per Morphit's auth policy. The three
		// fee-bearing op types (order-create, feature-bid, stranger-fee) carry
		// an active-authority fee `transfer` in the SAME tx, and Blurt forbids
		// mixing posting + active in one tx — so those ops are active-level.
		// Allow active auth for exactly those; every other op stays posting-only.
		const feeBearing =
			op.id === OP_IDS.order || op.id === OP_IDS.featureBid || op.id === OP_IDS.strangerFee;
		const signerResult = extractSigner(op, feeBearing);
		if (!signerResult.ok) {
			await writeEventLog(client, {
				blockNum,
				trxInBlock,
				opInTrx,
				blockTime,
				trxId,
				signer: op.required_posting_auths[0] ?? '',
				opId: op.id,
				payload: op.json, // raw string; parse failed or not attempted
				status: 'rejected',
				rejectReason: signerResult.reason
			});
			rejected++;
			continue;
		}
		const signer = signerResult.signer;

		// Step 2: parse the payload.
		const payload = parseJsonPayload(op);
		if (payload === null) {
			await writeEventLog(client, {
				blockNum,
				trxInBlock,
				opInTrx,
				blockTime,
				trxId,
				signer,
				opId: op.id,
				payload: { _raw: op.json },
				status: 'rejected',
				rejectReason: 'malformed_json'
			});
			rejected++;
			continue;
		}

		// Step 3: find the handler. If none is registered yet, lodge a
		// clear 'handler_not_implemented' rejection rather than silently
		// skipping — that way the event log surfaces the mismatch.
		const handler = HANDLERS[op.id];
		if (!handler) {
			await writeEventLog(client, {
				blockNum,
				trxInBlock,
				opInTrx,
				blockTime,
				trxId,
				signer,
				opId: op.id,
				payload,
				status: 'rejected',
				rejectReason: 'handler_not_implemented'
			});
			rejected++;
			continue;
		}

		// Step 4: invoke the handler inside a savepoint. A savepoint
		// gives us op-level rollback without leaving the block-level
		// transaction: if the handler writes something then returns
		// `{ ok: false }` (or throws), we roll back to the savepoint
		// and the writes vanish — only the event-log entry for the
		// rejection persists. Well-written handlers validate before
		// writing, but savepoints defend against future handlers that
		// don't.
		// Per-op buffer for orderbook changes.  Only flushed to the
		// block-level set if the handler returns ok:true; otherwise
		// the savepoint rollback discards them in lockstep with the
		// DB writes they would have signaled.
		const opPendingChanges: string[] = [];
		// Same pattern for chat changes — buffer per op, flush on
		// ok:true, discard on reject/throw.
		const opPendingChatChanges: { lo: string; hi: string; messageId: number }[] = [];

		const ctx: OpContext = {
			blockNum,
			trxInBlock,
			opInTrx,
			blockTime,
			trxId,
			signer,
			payload,
			siblingOps,
			blurt,
			config,
			feeVerifiers,
			feeAmounts,
			fiatToUsd,
			recordOrderbookChange: (orderId: string): void => {
				opPendingChanges.push(orderId);
			},
			recordChatChange: (ev): void => {
				opPendingChatChanges.push({
					lo: ev.lo,
					hi: ev.hi,
					messageId: ev.messageId
				});
			}
		};

		// Defense-in-depth: identifier components for SAVEPOINT must
		// be safe SQL identifier characters.  Both come from JS array
		// indices upstream so they're integers in normal flow; the
		// guard catches a future refactor that lets a string slip
		// through.  (PostgreSQL identifier rules: [a-zA-Z_][a-zA-Z0-9_]*.)
		if (
			!Number.isInteger(trxInBlock) ||
			trxInBlock < 0 ||
			!Number.isInteger(opInTrx) ||
			opInTrx < 0
		) {
			throw new Error(
				`dispatcher: refusing non-integer savepoint key ` +
					`trxInBlock=${trxInBlock} opInTrx=${opInTrx}`
			);
		}
		const savepointName = `op_${trxInBlock}_${opInTrx}`;
		await client.query(`SAVEPOINT ${savepointName}`);

		let result;
		try {
			result = await handler(ctx, client);
		} catch (err) {
			// Op-level rollback discards any pending orderbook /
			// chat changes the handler queued before throwing.
			opPendingChanges.length = 0;
			opPendingChatChanges.length = 0;
			await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
			const reason =
				err instanceof Error ? `handler_threw:${err.message.slice(0, 120)}` : 'handler_threw';
			await writeEventLog(client, {
				blockNum,
				trxInBlock,
				opInTrx,
				blockTime,
				trxId,
				signer,
				opId: op.id,
				payload,
				status: 'rejected',
				rejectReason: reason
			});
			rejected++;
			continue;
		}

		// Step 5: write the verdict to the event log. On rejection,
		// roll back to the savepoint first so any writes the handler
		// made before returning `{ ok: false }` are discarded.
		if (result.ok) {
			await client.query(`RELEASE SAVEPOINT ${savepointName}`);
			// Flush this op's orderbook-change notifications into
			// the block-level set.  These won't fire on the bus
			// until the block transaction commits (handled by the
			// poller after withTx returns).
			for (const orderId of opPendingChanges) {
				orderbookChanges.add(orderId);
			}
			// Same pattern for chat-change notifications.
			for (const ev of opPendingChatChanges) {
				chatChanges.push(ev);
			}
			await writeEventLog(client, {
				blockNum,
				trxInBlock,
				opInTrx,
				blockTime,
				trxId,
				signer,
				opId: op.id,
				payload,
				status: 'applied',
				rejectReason: null
			});
			applied++;
			// Mark the account's first Morphit activity. Idempotent —
			// the UPDATE only touches rows where first_activity_at
			// IS NULL, so subsequent applied ops for the same account
			// are no-ops. Signal A reads this field to find pairs
			// of close-timed first activities under a shared creator.
			await markFirstActivity(client, signer, blockTime);
		} else {
			// Op-level rollback discards both the DB writes and any
			// orderbook / chat change notifications the handler
			// queued.
			opPendingChanges.length = 0;
			opPendingChatChanges.length = 0;
			await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
			await writeEventLog(client, {
				blockNum,
				trxInBlock,
				opInTrx,
				blockTime,
				trxId,
				signer,
				opId: op.id,
				payload,
				status: 'rejected',
				rejectReason: result.reason
			});
			rejected++;
		}
	}

	return {
		applied,
		rejected,
		skipped,
		orderbookChanges: Array.from(orderbookChanges),
		chatChanges
	};
}
