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

import { getBlurtClient } from '$blurt/client';
import { getRotator } from '$net/endpoints';
import { OP_IDS } from '$net/config';
import { verifyChainOpSignature } from './chainOpVerify';

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
	const rotator = getRotator();
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
	const outcomes = await rotator.callMany<HistoryEntry[]>(
		'condenser_api.get_account_history',
		[account, -1, limit],
		quorumN
	);
	const successful = outcomes.filter(
		(o): o is { url: string; ok: true; result: HistoryEntry[] } => o.ok
	);
	if (successful.length < agreeAtLeast) {
		// Not enough working endpoints for quorum; the user can't
		// safely accept ANY identity right now.
		return null;
	}
	// Per-endpoint: walk history backwards, find the latest
	// chat_identity op authored by `account`.  Defensively shape-
	// check the payload.
	const perEndpoint: Array<{ url: string; triple: ChainChatIdentity | null }> = successful.map(
		(o) => {
			const history = o.result;
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
					return {
						url: o.url,
						triple: {
							chatPubB64: payload.chat_pub,
							blockNum: op.block,
							trxId: op.trx_id
						}
					};
				} catch {
					continue;
				}
			}
			return { url: o.url, triple: null };
		}
	);
	// Tally agreement by exact (chatPubB64, blockNum, trxId)
	// equality.  null counts as its own bucket so an endpoint
	// reporting "no chat_identity op" disagrees with one
	// reporting a specific op.
	const tally = new Map<string, { count: number; triple: ChainChatIdentity | null }>();
	for (const e of perEndpoint) {
		const key =
			e.triple === null
				? '__none__'
				: `${e.triple.blockNum}:${e.triple.trxId}:${e.triple.chatPubB64}`;
		const slot = tally.get(key) ?? { count: 0, triple: e.triple };
		slot.count += 1;
		tally.set(key, slot);
	}
	let bestKey: string | null = null;
	let bestCount = 0;
	for (const [k, v] of tally) {
		if (v.count > bestCount) {
			bestKey = k;
			bestCount = v.count;
		}
	}
	if (bestKey === null || bestCount < agreeAtLeast) {
		// No quorum.  Surface the disagreement to devtools.
		// eslint-disable-next-line no-console
		console.warn(
			`[chainVerify] no quorum for ${account}: ${perEndpoint.length} endpoints reported`,
			perEndpoint.map((e) => ({
				url: e.url,
				key: e.triple === null ? '__none__' : `${e.triple.blockNum}:${e.triple.trxId}`
			}))
		);
		return null;
	}
	const winner = tally.get(bestKey);
	const triple = winner?.triple ?? null;

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
