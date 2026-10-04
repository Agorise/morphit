/**
 * Morphit chat — checks of a peer's chat-identity op, read through the
 * operator's chain relay.
 *
 * Companion to pubPin.ts. When the indexer reports a chat key for a peer, the
 * client checks the on-chain `morphit_chat_identity_v1` op it points at: the
 * transaction must carry that op, authored by the peer's posting authority,
 * and its signature must recover to a key in that authority (local secp256k1
 * verification, chainOpVerifyCore.ts). The chat key returned is the one in
 * the transaction, never the one in the indexer's row.
 *
 * What this does and does NOT defend against — stated plainly:
 *
 *   - Every read here (`get_transaction`, `get_accounts`,
 *     `get_account_history`) goes through the SAME operator's
 *     `/v1/chain/condenser` relay (privacy #1: the browser does not contact
 *     Blurt nodes for chat). It therefore catches an indexer whose stored
 *     chat-identity data is wrong or stale, and a careless forgery. It does
 *     NOT stop a hostile operator, who can answer with a transaction signed by
 *     its own key and an authority that lists that key.
 *   - That is why pubPin.ts never moves an existing pin to a DIFFERENT key on
 *     the strength of this check: a changed key waits for the user to compare
 *     the new safety number and accept it. First contact is
 *     trust-on-first-use; the Verify-peer safety number is the defense there.
 */

import type { AuthorityType, SignedTransaction } from '@beblurt/dblurt';
import { chainRelay, ChainRelayError } from '$net/chainRelay';
import { OP_IDS } from '$net/config';
import { verifyChainOpSignature, verifyTransactionSignatures } from './chainOpVerify';

/** 40-char lowercase-hex Blurt transaction id. */
const TRX_ID_RE = /^[a-f0-9]{40}$/;

/** What the chain says is the current chat-identity for an
 *  account.  Returned by verifyAndFetchLatestPub on success. */
export interface ChainChatIdentity {
	/** Base64-encoded 32-byte X25519 public key. */
	readonly chatPubB64: string;
	/** Block number of the op that established this pub. */
	readonly blockNum: number;
	/** Transaction ID of that op (40-char hex). */
	readonly trxId: string;
}

/** Shape of the morphit_chat_identity_v1 op payload (from
 *  apps/web/src/lib/blurt/ops/chatIdentity.ts).  We don't
 *  import the type to avoid a circular dependency with the
 *  broadcaster module; we narrow defensively here. */
interface ChatIdentityPayloadShape {
	readonly v: 1;
	readonly chat_pub: string;
	readonly ts: number;
}

function isChatIdentityPayload(v: unknown): v is ChatIdentityPayloadShape {
	if (typeof v !== 'object' || v === null) return false;
	const r = v as Record<string, unknown>;
	if (r.v !== 1) return false;
	if (typeof r.chat_pub !== 'string' || r.chat_pub.length === 0) return false;
	if (typeof r.ts !== 'number') return false;
	return true;
}

/**
 * The newest chat-identity op in `account`'s history, read through the
 * operator's chain relay (ONE source — see the file header). The fallback
 * when the indexer's claimed op cannot be checked directly.
 *
 * `quorumN` / `agreeAtLeast` are kept for call-site compatibility and have no
 * effect: the browser no longer asks several Blurt nodes for chat (privacy
 * #1), so there is nothing to agree.
 *
 * When `verifySignature` is true, the op's transaction signature is also
 * verified locally against the account's posting authority (both read
 * through the same relay).
 */
export async function fetchLatestChatIdentityFromChainQuorum(
	account: string,
	quorumN = 3,
	agreeAtLeast = 2,
	verifySignature = false
): Promise<ChainChatIdentity | null> {
	const limit = 10000;
	type HistoryEntry = [
		number,
		{
			block: number;
			trx_id: string;
			timestamp: string;
			op: [
				string,
				{ id?: string; required_auths: string[]; required_posting_auths: string[]; json: string }
			];
		}
	];
	// History is fetched ONCE through the operator's indexer relay (privacy #1).
	let history: HistoryEntry[] | null;
	try {
		history = await chainRelay<HistoryEntry[] | null>('get_account_history', [account, -1, limit]);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn(
			`[chainVerify] relay unreachable for ${account} (quorumN=${quorumN}, agreeAtLeast=${agreeAtLeast}): ${err instanceof Error ? err.message : String(err)}`
		);
		// COULD NOT ASK is not THE CHAIN SAYS NO. Returning null here collapsed
		// the two, and pub-pinning reads null as "the chain reports no key for
		// this peer" — a TAMPER signal. So a slow Tor circuit or a dropped I2P
		// tunnel told the user their operator might be fabricating data, and
		// advised them to switch instances: useless advice for someone on a
		// hidden-only instance precisely because the others are blocked where
		// they are. ChainRelayError exists to carry this distinction (see its
		// own docstring); it was being discarded one line after being thrown.
		if (err instanceof ChainRelayError) throw err;
		return null;
	}
	if (!Array.isArray(history)) return null;
	// Walk history backwards, find the latest chat_identity op authored by
	// `account`. Defensively shape-check the payload.
	let triple: ChainChatIdentity | null = null;
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (!entry) continue;
		const op = entry[1];
		const [opName, opBody] = op.op;
		if (opName !== 'custom_json') continue;
		if (opBody.id !== OP_IDS.chatIdentity) continue;
		const authedBy = [...opBody.required_auths, ...opBody.required_posting_auths];
		if (!authedBy.includes(account)) continue;
		try {
			const payload = JSON.parse(opBody.json);
			if (!isChatIdentityPayload(payload)) continue;
			triple = {
				chatPubB64: payload.chat_pub,
				blockNum: op.block,
				trxId: op.trx_id
			};
			break;
		} catch {
			continue;
		}
	}
	if (triple === null) return null;

	// Local secp256k1 verification of the op's transaction against the
	// account's posting authority (both via the relay). Catches a wrong or
	// careless indexer answer; not an operator that forges both.
	if (verifySignature && triple !== null) {
		try {
			const verdict = await verifyChainOpSignature(triple.trxId, account);
			if (!verdict.ok) {
				// eslint-disable-next-line no-console
				console.warn(
					`[chainVerify] signature verification failed for ${account} (trx ${triple.trxId}): ${verdict.code} — ${verdict.message}`
				);
				return null;
			}
		} catch (err) {
			// RPC failure during signature verify.  Per the contract,
			// the caller MUST treat verify-failed as no-result.
			// eslint-disable-next-line no-console
			console.warn(
				`[chainVerify] signature verification threw for ${account}: ${err instanceof Error ? err.message : String(err)}`
			);
			// ...but "the relay was unreachable" is not a verification result at
			// all, and must not become a tamper accusation. Same reasoning as
			// the history fetch above.
			if (err instanceof ChainRelayError) throw err;
			return null;
		}
	}
	return triple;
}

/**
 * Verify the indexer's CLAIMED chat-identity op directly, by transaction id.
 *
 * the witness-history fix.  fetchLatestChatIdentityFromChain*
 * (above) find a peer's chat-identity op by WALKING account history.  For a
 * Blurt block producer that op is buried under hundreds of thousands of
 * `producer_reward` virtual ops — far beyond the 10000-entry per-call cap
 * (Blurt's max), which for an active witness covers barely a week.  The walk
 * then finds nothing and returns null → pubPin throws `chain_reports_none` →
 * the chat UI shows a false "tamper detected" and blocks the send.  Field
 * report: nobody could open a chat with the witness @khrom, while ordinary
 * (non-producing) peers worked fine.
 *
 * This path is O(1) and immune to account activity.  The indexer already tells
 * us the (block_num, trx_id) of the op it indexed — and it stores the REAL
 * on-chain trx_id of the peer's latest identity op (see
 * apps/indexer/.../handlers/chatIdentity.ts).  We fetch THAT transaction,
 * confirm it carries a `morphit_chat_identity_v1` custom_json authored by
 * `peer`'s posting authority, verify the transaction's signature locally
 * against peer's posting key, and return the transaction's chat_pub.
 *
 * What it proves, and what it does not: the transaction and the authority are
 * both read through the operator's relay, so this catches an indexer whose
 * stored row is wrong (a stale or corrupt chat_identities entry, a trx id that
 * is not a chat-identity op by peer) — but an operator that forges BOTH the
 * transaction and the authority passes it. pubPin.ts therefore never lets
 * this check alone move a pin to a different key. The returned pub is the
 * transaction's, never the indexer row's.
 *
 * Returns the chain-authoritative triple, or null if the claimed transaction
 * isn't a valid chat-identity op authored by peer.  Throws on an RPC-layer
 * failure (the caller MUST treat a throw as verification-failed; falling back
 * to the indexer's word would defeat the defense).
 */
export async function verifyClaimedChatIdentityOnChain(
	peer: string,
	claimed: { readonly blockNum: number; readonly trxId: string }
): Promise<ChainChatIdentity | null> {
	if (typeof claimed.trxId !== 'string' || !TRX_ID_RE.test(claimed.trxId)) return null;

	// 1. Fetch the full annotated signed transaction (carries block_num).
	//    chainRelay throws on a relay/chain transport failure → propagates.
	const tx = await chainRelay<SignedTransaction | null>('get_transaction', [claimed.trxId]);
	if (tx === null || typeof tx !== 'object') return null;
	const ops = (tx as { operations?: unknown }).operations;
	if (!Array.isArray(ops)) return null;

	// 2. Find the chat-identity op authored by `peer`.  Defensive narrowing
	//    mirrors blurtVerify.ts — condenser get_transaction returns operations
	//    as [opName, opBody] tuples.
	let chatPubB64: string | null = null;
	for (const opEntry of ops) {
		if (!Array.isArray(opEntry) || opEntry.length !== 2) continue;
		const opName = opEntry[0];
		const opBody = opEntry[1];
		if (opName !== 'custom_json') continue;
		if (typeof opBody !== 'object' || opBody === null) continue;
		const body = opBody as {
			id?: unknown;
			required_auths?: unknown;
			required_posting_auths?: unknown;
			json?: unknown;
		};
		if (body.id !== OP_IDS.chatIdentity) continue;
		const authed = [
			...(Array.isArray(body.required_auths) ? (body.required_auths as unknown[]) : []),
			...(Array.isArray(body.required_posting_auths)
				? (body.required_posting_auths as unknown[])
				: [])
		];
		if (!authed.includes(peer)) continue;
		if (typeof body.json !== 'string') continue;
		let payload: unknown;
		try {
			payload = JSON.parse(body.json);
		} catch {
			continue;
		}
		if (!isChatIdentityPayload(payload)) continue;
		chatPubB64 = payload.chat_pub;
		break;
	}
	if (chatPubB64 === null) return null;

	// 3. Fetch peer's posting authority (via the relay) and verify the
	//    transaction signature locally against it.
	const accounts = await chainRelay<Array<{ posting?: AuthorityType }>>('get_accounts', [[peer]]);
	if (!Array.isArray(accounts) || accounts.length === 0 || !accounts[0]?.posting) {
		// eslint-disable-next-line no-console
		console.warn(
			`[chainVerify] claimed chat-identity: account ${peer} not found or missing posting authority`
		);
		return null;
	}
	let verdict;
	try {
		verdict = await verifyTransactionSignatures(tx, accounts[0].posting);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn(
			`[chainVerify] claimed chat-identity signature verify threw for ${peer} (trx ${claimed.trxId}): ${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}
	if (!verdict.ok) {
		// eslint-disable-next-line no-console
		console.warn(
			`[chainVerify] claimed chat-identity signature verify failed for ${peer} (trx ${claimed.trxId}): ${verdict.code}`
		);
		return null;
	}

	// 4. Chain-authoritative block_num from the annotated tx; if a
	//    non-conformant node omits it, fall back to the claimed block for the
	//    (already checked) trx so pin monotonicity still has a value.
	const chainBlock = (tx as { block_num?: unknown }).block_num;
	const blockNum =
		typeof chainBlock === 'number' && Number.isFinite(chainBlock) && chainBlock > 0
			? chainBlock
			: claimed.blockNum;

	return { chatPubB64, blockNum, trxId: claimed.trxId };
}

/**
 * Peer chat-identity chain verification used by the chat send + fingerprint
 * paths (chatService, peerPubFetch).  Prefers the O(1) claimed-op check
 * (verifyClaimedChatIdentityOnChain) so high-activity accounts like witnesses
 * verify correctly; if the claimed op can't be validated (e.g. an older
 * indexer that didn't serve a usable trx_id, or a transient miss), falls back
 * to the account-history walk with local signature verification.  Both legs go
 * only through the operator's chain relay (privacy #1).
 *
 * `claimed` is what the indexer returned for this peer; passing it lets the
 * primary path chase the exact op rather than re-deriving "the latest" from a
 * bounded, witness-defeating history window.  Works identically whether or not
 * the surrounding chat is bound to an order — chat-identity is per-peer, never
 * per-thread.
 */
export async function verifyPeerChatIdentityOnChain(
	peer: string,
	claimed: { readonly blockNum: number; readonly trxId: string }
): Promise<ChainChatIdentity | null> {
	const direct = await verifyClaimedChatIdentityOnChain(peer, claimed);
	if (direct !== null) return direct;
	return fetchLatestChatIdentityFromChainQuorum(peer, 3, 2, true);
}
