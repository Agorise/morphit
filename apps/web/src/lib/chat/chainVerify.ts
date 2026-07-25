/**
 * Morphit chat — chain-RPC verification of chat-identity ops.
 *
 * Companion to pubPin.ts: the "verify" half of Option 5.  When
 * the indexer reports a chat_pub the local user hasn't seen
 * before (a newer (block_num, trx_id) reference than the pinned
 * one), we don't take the indexer's word for it.  Instead we
 * ask a Blurt RPC node what the chain itself says.
 *
 *
 * Why "ask the chain" defends against a compromised indexer
 * ──────────────────────────────────────────────────────────
 *
 * The `morphit_chat_identity_v1` op is a `custom_json` with
 * `required_posting_auths = [<account>]`.  Blurt nodes verify
 * the signature when accepting blocks; any custom_json op that
 * lands in a finalized block was, by the chain's rules, signed
 * by the named account's posting authority.
 *
 * So when a Blurt RPC tells us "the latest
 * morphit_chat_identity_v1 from @alice is at block N,
 * payload {chat_pub: P}", we know:
 *
 *   1. @alice (or someone with her posting key) authored that op.
 *   2. The chain accepted it.
 *   3. P is the pub @alice (currently) wants others to encrypt to.
 *
 * An attacker who controls the indexer can swap the pub @alice
 * publishes only by inducing the indexer to LIE about
 * chat_identities.  This module catches that lie by going
 * straight to the chain.
 *
 *
 * Trust assumptions
 * ─────────────────
 *
 * We are now trusting the Blurt RPC layer instead of the
 * indexer.  This is a strict improvement because:
 *
 *   - The Blurt RPC set is more decentralized than Morphit's
 *     operator set.  Anyone can run a node.
 *   - The frontend's existing endpoint rotator queries multiple
 *     RPCs and surfaces failures; a single malicious node
 *     produces a noisy failure rather than silent MITM.
 *   - A Blurt RPC that returns a forged op would have to
 *     produce a signature that wouldn't validate against the
 *     account's on-chain posting key — and the user could
 *     verify that themselves, which raises the bar from "lie
 *     about a JSON field" to "forge an EC signature against a
 *     known pubkey."
 *
 *
 * What this module does NOT do
 * ────────────────────────────
 *
 *   - It does not re-verify EC signatures locally.  We trust
 *     the RPC node returned the op only because the chain
 *     accepted it, which means a witness verified the
 *     signature.  Verifying again locally would be defense in
 *     depth but would require pulling secp256k1 + dblurt
 *     signature parsing into this module.  Left for a future
 *     hardening pass.
 *   - It does not chase a specific (block_num, trx_id) the
 *     indexer claimed.  It just asks "what's the latest"
 *     directly from the chain.  The chain's "latest" is the
 *     authority; whatever the indexer claimed is irrelevant
 *     once we hit the chain.
 */

import type { AuthorityType, SignedTransaction } from '@beblurt/dblurt';
import { getBlurtClient } from '$blurt/client';
import { chainRelay } from '$net/chainRelay';
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
 * Fetch the chain-authoritative chat-identity for an account.
 *
 * Returns the (chat_pub, block_num, trx_id) triple from the
 * latest `morphit_chat_identity_v1` op signed by the named
 * account's posting authority on the Blurt chain, or null if
 * the account has never published.
 *
 * Throws if the RPC layer fails entirely (all endpoints down,
 * network error).  The caller MUST treat a thrown error as
 * verification-failed and refuse to use the indexer's claimed
 * pub: that's the whole point of going to the chain.  Falling
 * back to the indexer would defeat the defense.
 *
 * Caching: this function does NOT cache.  The caller (chatService
 * fetchPeerChatPub) only calls this on a pin-mismatch path,
 * which is rare in practice (legitimate posting-key rotations
 * are rare events).  Caching would risk serving stale data on
 * a real rotation; not worth it.
 */
export async function fetchLatestChatIdentityFromChain(
	account: string
): Promise<ChainChatIdentity | null> {
	const client = getBlurtClient();
	// Walk a large history window (10000 = Blurt's per-call cap)
	// to avoid false-positive 'chain_reports_none' for active
	// accounts whose chat-identity op may be buried deep in
	// history.  The default limit (500) is too small for accounts
	// with several months of activity since their last identity
	// publication.
	const found = await client.getLatestCustomJson<unknown>(account, OP_IDS.chatIdentity, 10000);
	if (found === null) return null;

	if (!isChatIdentityPayload(found.payload)) {
		// The op exists on chain but its payload isn't shaped
		// the way we expect.  Could be a future protocol version
		// (v: 2 etc.) the user's client doesn't understand yet.
		// Refuse to use it rather than guessing.
		return null;
	}

	// We have a verified op.  getLatestCustomJson already
	// confirmed required_posting_auths includes `account`, which
	// (because the chain accepted the op) means the account's
	// posting key signed it.  block, trx_id come straight from
	// the RPC's view of the canonical chain.
	return {
		chatPubB64: found.payload.chat_pub,
		blockNum: found.blockNumber,
		trxId: found.trxId
	};
}

/**
 * Audit 2026-05 finding 2-7: quorum verifier.
 *
 * fetchLatestChatIdentityFromChain trusts the single endpoint
 * the rotator picked.  A hostile node in the user's endpoint
 * set returning a forged op body wins.  This function queries
 * up to `quorumN` endpoints in parallel and demands that at
 * least `agreeAtLeast` of the successful responses agree on
 * the (chatPubB64, blockNum, trxId) triple.
 *
 * Disagreement (any non-trivial fork between endpoints on what
 * "the latest chat-identity op" is) returns null and surfaces
 * a console warning.  The caller must treat null as
 * verification-failed.
 *
 * Defaults: quorumN=3, agreeAtLeast=2.  Tunable via parameters
 * for tests and future tightening.  3-of-3 agreement is even
 * stronger but tolerates no transient endpoint failures.
 *
 * S14 (Audit Part 26): when `verifySignature` is true, after
 * the quorum agrees the function also performs a local
 * secp256k1 verification of the chain op's signature against
 * the account's on-chain posting authority.  Default off
 * because it adds two RPC roundtrips (get_transaction +
 * get_accounts).  Pin-mismatch callers opt in.
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
	// cp410 — the browser no longer queries Blurt nodes directly (privacy #1).
	// History is fetched ONCE through the operator's indexer relay (which reads
	// its own canonical pool). The old browser-side multi-node quorum collapses
	// onto the indexer; `quorumN` / `agreeAtLeast` are retained for API
	// compatibility. `verifySignature` still checks the winning op's signature
	// locally (below), and the cautious can use the chat UI's block-explorer
	// "verify" link.
	let history: HistoryEntry[] | null;
	try {
		history = await chainRelay<HistoryEntry[] | null>('get_account_history', [account, -1, limit]);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn(
			`[chainVerify] relay unreachable for ${account} (quorumN=${quorumN}, agreeAtLeast=${agreeAtLeast}): ${err instanceof Error ? err.message : String(err)}`
		);
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

	// S14 — local secp256k1 verification (Audit Part 26).
	// When verifySignature is true, after the quorum agrees on
	// (chatPubB64, blockNum, trxId), we fetch the full signed
	// transaction and verify the signature locally against the
	// account's posting authority.  This raises the bar for an
	// adversary controlling a quorum of RPC endpoints from
	// "lie about a JSON field" to "produce a valid secp256k1
	// signature against a key we don't possess."
	//
	// Default off because it costs an extra get_transaction +
	// get_accounts RPC.  Callers on the pin-mismatch hot path
	// (chatService) opt in.
	if (verifySignature && triple !== null) {
		try {
			const verdict = await verifyChainOpSignature(triple.trxId, account);
			if (!verdict.ok) {
				// eslint-disable-next-line no-console
				console.warn(
					`[chainVerify] S14 signature verification failed for ${account} (trx ${triple.trxId}): ${verdict.code} — ${verdict.message}`
				);
				return null;
			}
		} catch (err) {
			// RPC failure during signature verify.  Per S14 contract,
			// the caller MUST treat verify-failed as no-result.
			// eslint-disable-next-line no-console
			console.warn(
				`[chainVerify] S14 signature verification threw for ${account}: ${err instanceof Error ? err.message : String(err)}`
			);
			return null;
		}
	}
	return triple;
}

/**
 * Verify the indexer's CLAIMED chat-identity op directly, by transaction id.
 *
 * cp554/v1.8.15 — the witness-history fix.  fetchLatestChatIdentityFromChain*
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
 * against peer's on-chain posting key (S14), and return the CHAIN's chat_pub.
 *
 * Security is preserved, not weakened.  A hostile indexer still cannot
 * substitute a pub: any real on-chain op authored by peer carries peer's real
 * chat_pub (the operator lacks peer's posting key to forge one); a fabricated
 * trx_id fails `get_transaction`; a real transaction that isn't a
 * chat-identity by peer fails the op/author checks.  The returned pub is the
 * chain's, never the indexer's — the indexer's claimed pub is only a hint used
 * upstream (comparePin) to choose the state-machine branch.
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

	// 3. Fetch peer's posting authority and verify the transaction signature
	//    locally (S14 anti-fabrication).  Reuses the same pure core as the
	//    history-walk path's verifySignature leg; costs one get_accounts RPC.
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
	//    (already chain-verified) trx so pin monotonicity still has a value.
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
