/**
 * Morphit chat — chain-verified peer pub fetcher.
 *
 * Wraps the existing chatService runtime fetcher so it's
 * reusable from any caller that needs the same chain-anchored
 * resolution (chat send, OOB fingerprint verification).
 *
 * Backlog item 11 follow-up: the verify-peer panel
 * MUST use this same path, not a raw `getChatIdentity`
 * call.  Otherwise the fingerprint could be computed over an
 * indexer-supplied pub that differs from the chain-verified
 * pub used to actually encrypt messages — defeating the
 * point.  By centralizing here we guarantee both call sites
 * stay aligned.
 *
 * ─── Threat model recap ────────────────────────────────────
 *
 * The indexer is untrusted.  It might serve a fake peer pub
 * to enable MITM.  resolveChatPubFromIndexer (in pubPin.ts)
 * defends by:
 *   1. Pinning on first sight (TOFU): if the user has chatted
 *      with this peer before, any change in the published
 *      chat-pub must be backed by a NEWER chain reference
 *      than the previous pin.
 *   2. Chain quorum: the chain check itself queries multiple
 *      RPC endpoints and requires agreement (chainVerify.ts).
 *   3. Same-ref tamper detection: if the indexer claims a
 *      certain (blockNum, trxId) reference but the chain at
 *      that reference holds a DIFFERENT pub, reject as
 *      tampered.
 *
 * The OOB fingerprint adds a fourth defense: even if the
 * indexer + chain all agree from each side's perspective,
 * the user can OOB-compare the fingerprint with their
 * counterparty to detect bilateral attacks.
 */

import { resolveChatPubFromIndexer, PubPinError, type ChatPubPin } from '$lib/chat/pubPin';
import { verifyPeerChatIdentityOnChain } from '$lib/chat/chainVerify';
import { decodeChatPub } from '$lib/chat/crypto';
import { getChatIdentity } from '$lib/indexer/client';
import { ChainRelayError } from '$net/chainRelay';

/** Result of a peer-pub fetch. */
export type PeerPubFetchResult =
	| { kind: 'ok'; pub: Uint8Array }
	| { kind: 'not_published' }
	| { kind: 'indexer_error'; message: string }
	/** The chain could not be REACHED to verify against. Deliberately distinct
	 *  from `tamper_detected`: nothing about the peer's key is in question, we
	 *  simply have no answer yet. Conflating the two is how a slow Tor circuit
	 *  came to accuse an operator of fabricating data. */
	| { kind: 'chain_unreachable'; message: string }
	| { kind: 'tamper_detected'; code: string }
	| { kind: 'malformed_key' };

/** Fetch the peer's chat pubkey via the same chain-anchored
 *  path the chat send flow uses.  Returns a tagged result so
 *  callers can branch on each failure mode without try/catch
 *  ceremony. */
export async function fetchPeerChatPubChainVerified(peer: string): Promise<PeerPubFetchResult> {
	let indexerResp: Awaited<ReturnType<typeof getChatIdentity>>;
	try {
		indexerResp = await getChatIdentity(peer);
	} catch (err) {
		return {
			kind: 'indexer_error',
			message: err instanceof Error ? err.message : 'fetch failed'
		};
	}
	if (!indexerResp.ok) {
		if (indexerResp.code === 'not_found') {
			return { kind: 'not_published' };
		}
		return { kind: 'indexer_error', message: indexerResp.message };
	}

	const indexerPin: ChatPubPin = {
		blockNum: indexerResp.data.source_block_num,
		trxId: indexerResp.data.source_trx_id,
		pubB64: indexerResp.data.chat_pub
	};

	let trustedPubB64: string;
	try {
		trustedPubB64 = await resolveChatPubFromIndexer(
			peer,
			indexerPin,
			// Same claimed-op-first verifier as chatService, so the
			// OOB fingerprint is computed over the exact chain pub the
			// send path trusts — including for witness peers whose
			// identity op is buried beyond the history window.
			(p, claimed) => verifyPeerChatIdentityOnChain(p, claimed)
		);
	} catch (err) {
		// IMPORTANT: discriminate PubPinError (real tamper signal
		// with a stable code we surface to the user) from any other
		// error (chain RPC timeout, network glitch, malformed
		// response from the chain quorum).  A false-positive
		// "tamper detected" banner on a transient RPC issue would
		// undermine the alarm — users would learn to dismiss it.
		// Only the PubPinError branch routes to tamper_detected;
		// everything else is generic indexer_error.
		if (err instanceof PubPinError) {
			return { kind: 'tamper_detected', code: err.code };
		}
		// The chain relay could not be reached (a hidden-transport circuit that
		// never came up, the instance briefly unreachable, an aborted request).
		// Report it as what it is. The user can retry; there is nothing here to
		// be alarmed about and no reason to send them looking for another
		// instance — advice that is actively wrong for anyone whose instance is
		// hidden-only *because* the others are blocked where they are.
		if (err instanceof ChainRelayError) {
			return { kind: 'chain_unreachable', message: err.message };
		}
		return {
			kind: 'indexer_error',
			message: err instanceof Error ? err.message : 'chain verify failed'
		};
	}

	let pub: Uint8Array;
	try {
		pub = decodeChatPub(trustedPubB64);
	} catch {
		return { kind: 'malformed_key' };
	}
	if (pub.length !== 32) {
		return { kind: 'malformed_key' };
	}
	return { kind: 'ok', pub };
}
