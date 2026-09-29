/**
 * Morphit indexer — "did this account really sign this block transaction?"
 *
 * WHY THIS EXISTS (v1.20.0 fix wave, E1). The head tailer reads a head block
 * from ONE RPC endpoint — whichever the pool ranks first — and used to emit
 * every chat op in it as a live message from the account the op NAMES. Nothing
 * checked a signature: a single hostile endpoint in the pool could hand us a
 * "head block" holding an unsigned chat op "from @alice", and every open
 * chatroom here showed it as hers, with a push notification on top. The same
 * went for provisional order cancels (hiding any live order from every open
 * orderbook for ~90 s) and fast review notifications.
 *
 * The peer-push path never had this hole: it recovers the signer's key from
 * the transaction digest (chatFastFederation.verifyPushedChatOp). This module
 * gives the head tailer the same proof, over the WHOLE block transaction (a
 * chat op may ride with other ops), against the same posting-key lookup the
 * intake uses — so an unconfirmed key is confirmed through the quorum refresh,
 * never trusted from a single-source write.
 *
 * WHAT A "NO" COSTS. Nothing durable: the message is not shown live from this
 * head block, and still arrives by a peer's push (verified) or by the durable
 * poller (~60 s). An unverifiable message is never shown early.
 *
 * Imports only TYPES from chatFastFederation, so it adds no runtime import
 * cycle (chatFastFederation imports the head tailer).
 */

import type { FastFederationDb, PostingKeyLookup } from '$indexer/chatFastFederation';
import type { BlockTransaction } from '$blurt/client';

/** Did `signer` sign `trx` with its posting key? */
export type TrxSignerCheck = (trx: BlockTransaction, signer: string) => Promise<boolean>;

/** Every public key the transaction's signatures recover to, lazily, up to
 *  `max` signatures. Returns a predicate; recovery happens at most once per
 *  signature. Unusable transaction → a predicate that is always false. */
async function signedByPredicate(
	trx: BlockTransaction,
	max = 4
): Promise<(key: string) => boolean> {
	const { cryptoUtils, Signature } = await import('@beblurt/dblurt');
	let digest: Buffer;
	try {
		const t = trx as BlockTransaction & { extensions?: unknown[] };
		digest = cryptoUtils.transactionDigest({
			ref_block_num: t.ref_block_num,
			ref_block_prefix: t.ref_block_prefix,
			expiration: t.expiration,
			operations: t.operations,
			extensions: Array.isArray(t.extensions) ? t.extensions : []
		} as never);
	} catch {
		return () => false;
	}
	const sigs = Array.isArray(trx.signatures) ? trx.signatures.slice(0, max) : [];
	const recovered: string[] = [];
	let next = 0;
	return (key: string): boolean => {
		if (recovered.includes(key)) return true;
		while (next < sigs.length) {
			const s = sigs[next++];
			if (typeof s !== 'string' || s.length > 200) continue;
			try {
				const k = Signature.fromString(s).recover(digest).toString();
				recovered.push(k);
				if (k === key) return true;
			} catch {
				/* a malformed signature proves nothing */
			}
		}
		return false;
	};
}

/**
 * Build the check from a posting-key lookup (the same one the federation intake
 * builds, with the quorum refresher).
 *
 * The lookup is asked WITHOUT the network: the tailer must never wait on the
 * chain (it walks blocks in order). Where a chain read is needed — an
 * unconfirmed key, a lagging poller, a signature that does not match the key
 * on file — the read is started in the background (its answer is cached for
 * the next message from that sender) and THIS message is not shown live.
 */
export function trxSignedByPostingKey(lookup: PostingKeyLookup): TrxSignerCheck {
	const background = (p: Promise<unknown>): void => {
		void p.catch(() => undefined);
	};
	const isPending = (err: unknown): boolean =>
		err instanceof Error && err.name === 'KeyRefreshPending';
	return async (trx, signer) => {
		const signedBy = await signedByPredicate(trx);
		let key: string | null;
		try {
			key = await lookup(signer, { network: false, signedBy });
		} catch (err) {
			if (isPending(err)) background(lookup(signer, { signedBy }));
			return false;
		}
		if (key !== null && key.length > 0 && signedBy(key)) return true;
		if (key !== null && key.length > 0) {
			// Maybe a rotation the column has not caught up with: ask (bounded by
			// the refresh budget), in the background.
			try {
				await lookup(signer, { refresh: true, network: false });
			} catch (err) {
				if (isPending(err)) background(lookup(signer, { refresh: true }));
			}
		}
		return false;
	};
}

/**
 * The default when nothing is injected: trust ONLY a key the chain has
 * confirmed (`posting_key_reconciled`), straight from the column, with no
 * chain read. Strictly narrower than the injected lookup; used by tests and
 * any construction that does not wire the quorum refresher.
 */
export function reconciledColumnLookup(db: FastFederationDb): PostingKeyLookup {
	return async (account: string): Promise<string | null> => {
		const r = await db.query<{ posting_pubkey: string | null; posting_key_reconciled: boolean }>(
			'SELECT posting_pubkey, posting_key_reconciled FROM accounts WHERE name = $1',
			[account]
		);
		const row = r.rows[0];
		if (row === undefined || row.posting_key_reconciled !== true) return null;
		return row.posting_pubkey;
	};
}
