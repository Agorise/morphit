/**
 * Morphit indexer — POST /v1/broadcast. Anchor.
 *
 *   POST /v1/broadcast   body: { "trx": <signed Blurt transaction>,
 *                                 "chat_async"?: true }
 *     200 → { block_num, trx_id }  — `block_num` is null when the client
 *           asked for `chat_async` on a chat-only transaction, because that
 *           is answered before any block exists (see `chat_async` below)
 *     400 → bad body / disallowed op / the CHAIN rejected the tx (message
 *           relays the chain's reason, e.g. "missing required posting
 *           authority", so the user sees what actually went wrong)
 *     502 (code "internal") → could not reach any Blurt node (the client
 *           treats this as "proxy unreachable" and surfaces a retryable error;
 *           there is deliberately NO direct-RPC fallback — see
 *           apps/web/src/lib/blurt/broadcastTransport.ts)
 *
 * WHY THIS EXISTS — PRIVACY (priority #1) + RELIABILITY. Until now the
 * browser broadcast EVERY Morphit op (orders, chat, profile, feedback,
 * blocks, listing-fee transfers) by calling a third-party Blurt RPC node
 * DIRECTLY. That (a) leaked the user's IP + their exact on-chain action to
 * RPC operators Morphit does not control — the same deanonymizing leak the
 * account-keys proxy closed for READS, but on WRITES, which are even
 * more sensitive — and (b) depended on whichever node the browser reached
 * returning a browser-valid CORS header and staying up, so one node changing
 * its CORS config or going down silently broke every broadcast. This is the
 * WRITE sibling of the read proxies: the signed transaction is
 * relayed across the full server-side rpc-pool (latency-aware best node +
 * cooldown failover), so third parties only ever see the indexer's request
 * and the browser opens no cross-origin RPC connection.
 *
 * NON-CUSTODIAL IS UNTOUCHED. The transaction arrives ALREADY SIGNED by the
 * user's key — signing is pure client-side crypto. The indexer never sees a
 * private key; it only forwards bytes the user already authorized.
 *
 * NOT AN OPEN RELAY. Each operation must be one Morphit actually broadcasts
 * (custom_json with a `morphit_*` id, transfer, comment, comment_options, or
 * vote); anything else (account_update, witness ops, …) is refused up front.
 * The chain itself charges the SIGNER's resource credits, so even within the
 * whitelist this can't be used to spam the chain — the cost lands on whoever
 * signed, not the operator.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { BlurtClient } from '$blurt/client';
import { isTransportError } from '$blurt/client';
import { errorBody } from '$api/shared';
import type { ChatFastDispatcher } from '$indexer/chatFastDispatcher';
import { CHAT_OP_ID as CHAT_MESSAGE_OP_ID, type LocatedChatOp } from '$indexer/headTailer';
import { computeTrxId, structuralCheckChatOp } from '$indexer/chatFastFederation';
import { noteOutboundChat } from '$indexer/recentOutboundChat';

/** Every custom_json id Morphit broadcasts is versioned `morphit_<name>_vN`. */
const MORPHIT_CUSTOM_JSON_ID_RE = /^morphit_[a-z0-9_]+$/;

/** Operation types Morphit ever broadcasts from the browser. */
const ALLOWED_OP_TYPES = new Set([
	'custom_json',
	'transfer',
	'comment',
	'comment_options',
	'vote',
	// claim unclaimed author/curation rewards into usable balances.
	// Posting-authority op; the signer can only claim their OWN rewards, so
	// whitelisting it can't be abused to move anyone else's funds.
	'claim_reward_balance',
	// wallet Power Up / Power Down. `transfer_to_vesting` stakes the
	// signer's own liquid BLURT into BP; `withdraw_vesting` unstakes it back.
	// Both are self-only (the op moves the SIGNER's own balance between liquid
	// and staked — it cannot move anyone else's funds, same safety class as
	// claim_reward_balance), so whitelisting them can't turn this into an open
	// relay. Without these the indexer rejected every Power Up/Down with
	// "operation type not permitted", surfacing to the user as a generic
	// on-chain error even though the signed op was perfectly valid.
	'transfer_to_vesting',
	'withdraw_vesting'
]);

/** A signed transaction, validated STRUCTURALLY only — the chain is the
 *  authority on semantic validity. operations: [ [type, payload], … ]. */
const txSchema = z.object({
	ref_block_num: z.number().int().nonnegative(),
	ref_block_prefix: z.number().int().nonnegative(),
	expiration: z.string().min(1).max(40),
	operations: z
		.array(z.tuple([z.string(), z.record(z.string(), z.unknown())]))
		.min(1)
		.max(10),
	// `.default([])`, not `.optional()`. The transaction serializer this service
	// uses to derive a trx id writes `extensions` unconditionally and reads
	// `.length` off it, so an absent field is not "an empty list" to it — it is a
	// TypeError. Every Morphit client sends `extensions: []`, so this never
	// fired; a client that did not would have had its chat message accepted by
	// the chain and then answered 502, with a retry button that duplicates it.
	extensions: z.array(z.unknown()).default([]),
	signatures: z
		.array(
			z
				.string()
				.regex(/^[0-9a-f]+$/i)
				.max(200)
		)
		.min(1)
		.max(8)
});
const bodySchema = z.object({
	trx: txSchema,
	/**
	 * The CLIENT asking to be answered before the transaction reaches a block.
	 *
	 * Deliberately opt-in, and deliberately outside `trx` — it is a request about
	 * how to broadcast, not part of what gets signed.
	 *
	 * The server cannot decide this unilaterally, because a browser tab can be
	 * older than the indexer serving it. A cached bundle from before this release
	 * calls the generic submit path, which treats a missing `block_num` as a
	 * malformed reply and throws: the user's chat message would be delivered to
	 * the recipient and shown to the sender as a permanent red failure, with a
	 * retry button that posts it again under a fresh client tag. Making the fast
	 * answer something the client ASKS for means an old bundle simply gets the old
	 * behaviour — it still benefits from fast federated delivery, it just waits
	 * for its own acknowledgement — and there is no combination of versions that
	 * produces a lie.
	 */
	chat_async: z.boolean().optional()
});

interface BroadcastOkBody {
	/**
	 * The block the transaction landed in — or `null` for a chat message, which
	 * is broadcast asynchronously and therefore answered before any block exists.
	 * See `isChatMessageOnly` below for why chat is the one exception.
	 */
	readonly block_num: number | null;
	readonly trx_id: string;
}

/**
 * True when EVERY operation in this transaction is a chat message.
 *
 * The distinction earns a whole function because it decides whether the sender
 * waits for a block.
 *
 * `broadcast_transaction_synchronous` does not return until the transaction is
 * IN a block, which on Blurt is up to a full 3,000 ms block interval — and on a
 * zero-clearnet instance that wait sits on top of a hidden round trip to the RPC
 * node and another from the sender's browser. Measured together that is over six
 * seconds before the sender is even told their message went, and no number of
 * RPC nodes changes it, because none of that time is spent talking to one.
 *
 * For a chat message the wait buys nothing. Both send paths in chatService.ts
 * discard the broadcast result; `block_num` is never read for a message. The
 * asynchronous `broadcast_transaction` still has the node validate signature,
 * authority and resource credits — a rejection is still a rejection — it simply
 * answers when the node has accepted the transaction rather than when a witness
 * has sealed it into a block. If it then somehow never reaches a block, the
 * message stays unconfirmed in the client exactly as it would have, because the
 * client reconciles against the durable row by `client_tag` regardless.
 *
 * ALL operations, not any. A chat op riding alongside a transfer keeps the
 * synchronous path: the money half of that transaction has a receipt to write
 * and genuinely needs its block number. Orders, feature bids, chat-IDENTITY
 * publication and account creation all read `block_num`, and all of them stay on
 * the synchronous path for that reason.
 */
/**
 * Did the chain refuse this broadcast because it ALREADY HAS the transaction?
 * The wordings blurtd and its libraries use; see the W5 note at the call site.
 */
function isDuplicateTransactionError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /duplicate transaction|duplicate_transaction|tx_duplicate|already in (?:the )?block ?chain/i.test(
		msg
	);
}

/**
 * The answer to a broadcast that failed.
 *
 * Transport error = couldn't reach any node → 502, which the client reports as
 * "your instance could not do it right now" and the user can retry. It does NOT
 * fall back to a direct browser→node broadcast: that would hand a third party
 * the user's IP alongside the exact action they just took, which is the leak
 * this proxy exists to close. A NON-transport error is a chain rejection →
 * surface its message (400) so the user sees the real reason.
 */
function failBroadcast(c: Context, err: unknown): Response {
	if (isTransportError(err)) {
		return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
	}
	const msg = err instanceof Error ? err.message : 'the chain rejected the transaction';
	return c.json(errorBody('bad_request', msg), 400);
}

/** The block a transaction is in, asked a few times one block apart (it may
 *  still be in a node's pending pool). Null when not found. */
async function lookupBlock(
	blurt: BlurtClient,
	trxId: string,
	delayMs: number
): Promise<number | null> {
	for (let i = 0; i < 4; i++) {
		try {
			const tx = await blurt.callCondenser<{ block_num?: unknown } | null>(
				'get_transaction',
				[trxId],
				{
					hedge: false
				}
			);
			if (tx !== null && typeof tx.block_num === 'number' && tx.block_num > 0) return tx.block_num;
		} catch {
			/* not indexed yet, or this node has no transaction lookup — ask again */
		}
		await new Promise((r) => setTimeout(r, delayMs));
	}
	return null;
}

function isChatMessageOnly(trx: { operations: readonly (readonly [string, unknown])[] }): boolean {
	if (trx.operations.length === 0) return false;
	return trx.operations.every(
		([type, payload]) =>
			type === 'custom_json' && (payload as { id?: unknown })?.id === CHAT_MESSAGE_OP_ID
	);
}

/**
 * `fastDispatch` is optional so every existing caller and test keeps working;
 * when present, a chat op is handed to the federation the moment it arrives.
 */
export function broadcastRoute(
	blurt: BlurtClient,
	fastDispatch?: ChatFastDispatcher,
	/**
	 * Deliver a chat message to THIS instance's own listeners.
	 *
	 * Both people on one instance is the ordinary case, and it was the slowest
	 * one: the federation peer list excludes self, so a local recipient got no
	 * fast delivery at all and waited for the head tailer to read the message
	 * back off the chain — a block interval, plus a poll interval, plus an RPC
	 * read, which on a privacy-only instance runs to 6.8 seconds for two people
	 * on the same server.
	 *
	 * Called only for a message whose signature verified HERE, against this
	 * instance's own record of the sender's posting key (the fast dispatcher's
	 * pre-send check, decision 'dispatched'), and only after the node accepted
	 * the transaction. The node's acceptance alone is not enough: the broadcast
	 * goes to ONE pool node, and a hostile or broken node can "accept" a
	 * transaction signed by the wrong key, which would then reach the named
	 * recipient's open chat and Web Push as if from the named sender. A message
	 * that cannot be verified here reaches local listeners through the head
	 * tailer instead, a few seconds later.
	 */
	localChatDeliver?: (located: LocatedChatOp, trxId: string) => void,
	/** Tuning, for tests. `duplicateLookupDelayMs` spaces the block lookups
	 *  made after a duplicate answer (default 3 s, one block). */
	opts: { readonly duplicateLookupDelayMs?: number } = {}
): Hono {
	const lookupDelayMs = opts.duplicateLookupDelayMs ?? 3_000;
	const app = new Hono();

	app.post('/', async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json(errorBody('bad_request', 'invalid JSON body'), 400);
		}

		const parsed = bodySchema.safeParse(json);
		if (!parsed.success) {
			return c.json(errorBody('bad_request', 'malformed transaction'), 400);
		}
		const { trx, chat_async: chatAsyncRequested } = parsed.data;

		// Op whitelist — bound what this relay can push to the chain.
		for (const [type, payload] of trx.operations) {
			if (!ALLOWED_OP_TYPES.has(type)) {
				return c.json(errorBody('bad_request', `operation type not permitted: ${type}`), 400);
			}
			if (type === 'custom_json') {
				const id = (payload as { id?: unknown }).id;
				if (typeof id !== 'string' || !MORPHIT_CUSTOM_JSON_ID_RE.test(id)) {
					return c.json(errorBody('bad_request', 'custom_json id not permitted'), 400);
				}
			}
		}

		// ─── FEDERATION FAST PATH ────────────────────────────────────────
		// Fired HERE, before the chain call below, and deliberately not awaited.
		//
		// The ordering is the whole point. `broadcast_transaction_synchronous`
		// blocks until the transaction is in a block — up to a full 3,000 ms
		// block interval — and the receiving instance then waits up to another
		// 2,000 ms for its head tailer to poll. Dispatching after that would
		// hand the federation a message five seconds late before a single
		// tunnel round trip had even been paid for, which is precisely why two
		// zero-clearnet instances could not hold a conversation.
		//
		// Not awaited, because the sender's own request must not wait on peers
		// either: the browser needs its acknowledgement back, and a slow or
		// dead peer is a normal condition that must not slow a send or fail it.
		// Errors are swallowed inside the dispatcher for the same reason.
		//
		// WHAT IT WILL SEND: only a chat-only
		// transaction that passes the peers' own structural check and verifies
		// against our own `accounts` row, and only as the rebuilt canonical copy.
		// One it cannot verify here waits for the node's acceptance below; one the
		// node refuses is never sent at all. It used to fan out anything carrying
		// a chat op, junk included, before the chain had seen it.
		const fast = fastDispatch?.dispatchIfChat(trx);

		// Is this a chat message? That decides the chat-side effects below — the
		// relay log, the local delivery — and they happen for EVERY chat message,
		// including one from a client that did not ask for the fast answer.
		const chatOnly = isChatMessageOnly(trx);
		// May we answer before a block? Only if it is chat AND the client asked.
		// See `chat_async` in the body schema for why the client has to ask.
		const chatAsync = chatOnly && chatAsyncRequested === true;
		const method = chatAsync ? 'broadcast_transaction' : 'broadcast_transaction_synchronous';

		let result: { block_num?: number; id?: string; trx_id?: string } | null;
		try {
			// hedge:false — NEVER parallel-fire a signed write. Hedging a
			// broadcast sends the same tx to a second node, whose
			// broadcast_transaction_synchronous then blocks on the duplicate
			// until the tx expires (~60s), stalling the whole send. Reads
			// hedge for speed; writes take the single-broadcast latency as the
			// cost of correctness — same policy the relay's broadcast uses.
			result = await blurt.callCondenser(method, [trx], {
				hedge: false
			});
		} catch (err) {
			// A DUPLICATE, answering the client that asked for the fast answer, is
			// the chain saying it ALREADY HAS this exact signed transaction
			// (v1.18.0 review, W5). It happens when a node accepted the send and
			// the answer was lost: the pool, after the timeout, offers the same
			// transaction to the next node, which refuses it as a duplicate. The
			// message has already gone out to the federation as well; reporting a
			// failure showed the sender a raw "duplicate…" error for a message on
			// its way to a block, and the retry it invites is a SECOND copy on
			// chain. So it is the success it is. Only for the asynchronous chat
			// answer, which carries no block number — an older tab, or anything
			// that must have a block, keeps the old reply.
			if (chatAsync && isDuplicateTransactionError(err)) {
				result = { trx_id: (await computeTrxId(trx)) ?? undefined };
				// The chain has these exact signed bytes: as good as accepted.
				fast?.chainAccepted();
			} else if (isDuplicateTransactionError(err)) {
				// the same holds for EVERY op, not just
				// chat. A node took this transaction and its reply was lost, then
				// the pool offered the same bytes to the next node, which already
				// had them. Answering 400 told the user their order / transfer
				// FAILED and invited a retry — a second, freshly-signed copy on
				// chain. The caller needs the block number, so look it up.
				const trxId = (await computeTrxId(trx)) ?? undefined;
				const block = trxId === undefined ? null : await lookupBlock(blurt, trxId, lookupDelayMs);
				if (trxId !== undefined && block !== null) {
					result = { trx_id: trxId, block_num: block };
					fast?.chainAccepted();
				} else {
					// Still not in a block we could find: say what is TRUE — the
					// network has it — so nobody signs a second copy.
					return c.json(
						errorBody(
							'bad_request',
							`This transaction is already on the Blurt network${trxId ? ` (id ${trxId})` : ''} and is being confirmed. ` +
								'It will appear shortly — do not send it again.'
						),
						400
					);
				}
			} else {
				return failBroadcast(c, err);
			}
		}
		// condenser_api.broadcast_transaction_synchronous returns
		// { id, block_num, trx_num, expired } — `id` is the trx hash. Normalize
		// to { block_num, trx_id } so the browser gets a populated trx_id (the
		// old direct-RPC path mistyped this and left trx_id undefined).
		let trx_id = (result?.trx_id ?? result?.id) as string | undefined;

		if (chatOnly) {
			// The node took it: a message the pre-send check could not verify
			// locally goes to the federation now. That is safe because
			// every peer verifies the signature itself on receipt.
			fast?.chainAccepted();
			// Did the signature verify HERE? Local effects — the outbound-pair
			// note and the delivery to our own listeners — need that, not just the
			// node's word (see localChatDeliver). A local check, no chain read.
			const verifiedHere = fast !== undefined && (await fast.decision) === 'dispatched';
			// Record that this account just wrote to that one — only for a
			// message verified here, and only after the node accepted it.
			// Recording on the node's word alone would let one lying node assert
			// a pair for any two accounts.
			//
			// This is what lets the OTHER side's reply notify this user inside the
			// six seconds, instead of waiting out the 45-63s the durable table
			// takes to admit the message we have just relayed ourselves. See
			// recentOutboundChat.ts.
			const located = structuralCheckChatOp(trx);
			if (located.ok && verifiedHere) {
				noteOutboundChat(located.located.signer, located.located.recipient);
			}

			// The asynchronous broadcast reports no block, by definition — there is
			// not one yet — so requiring a numeric block_num here would reject
			// every successful chat send. It also may not hand back an id at all:
			// blurtd's confirmation for the async method is `{ id }` at best and
			// empty at worst. The id is a pure function of the signed bytes, so it
			// is derived rather than demanded.
			if (typeof trx_id !== 'string' || trx_id.length === 0) {
				trx_id = (await computeTrxId(trx)) ?? undefined;
			}
			if ((typeof trx_id !== 'string' || trx_id.length === 0) && located.ok) {
				// Last resort, and a deliberate one: THE NODE HAS ALREADY TAKEN
				// THIS TRANSACTION. Answering 502 here would tell the sender their
				// message failed when it is on its way to a block and has very
				// likely already been delivered — and the retry that produces
				// posts it a second time, under a new client tag, so the recipient
				// sees it twice. The client tag is the same key the client and the
				// federation replay memory already dedupe on, so it identifies the
				// message well enough for everything that uses this value.
				trx_id = `tag:${located.located.clientTag}`;
			}
			if (typeof trx_id !== 'string' || trx_id.length === 0) {
				return c.json(errorBody('internal', 'unexpected broadcast result'), 502);
			}
			// Deliver to our OWN listeners. Fire-and-forget: the sender is waiting
			// on this response and must not also wait on the recipient's gates.
			if (located.ok && verifiedHere && localChatDeliver !== undefined) {
				localChatDeliver(located.located, trx_id);
			}

			// Only a client that ASKED for it gets the null. One that did not is
			// answered below in the ordinary shape, with the real block number the
			// synchronous broadcast it received actually returned — see
			// `chat_async`. Everything above this line ran for both.
			if (chatAsync) {
				const chatBody: BroadcastOkBody = { block_num: null, trx_id };
				return c.json(chatBody);
			}
		}

		const block_num = result?.block_num;
		if (typeof trx_id !== 'string' || typeof block_num !== 'number') {
			return c.json(errorBody('internal', 'unexpected broadcast result'), 502);
		}

		const body: BroadcastOkBody = { block_num, trx_id };
		return c.json(body);
	});

	return app;
}
