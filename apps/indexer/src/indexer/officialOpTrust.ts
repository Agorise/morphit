/**
 * Morphit indexer — was this op really signed by the pinned official key?
 *
 * The release (`morphit_release_v1`) and rpc-directory (`morphit_rpc_v1`) ops
 * steer every indexer: a release can move the treasury pin (the BTC xpub and
 * fee addresses users pay to), and the directory adds RPC nodes to the live
 * pool and counts each as a quorum operator.
 *
 * WHAT WAS WRONG. Both handlers checked only that the op NAMED the official
 * account and that one RPC endpoint, asked at apply time, said that account's
 * posting key was the pinned one. Nothing checked the transaction's signature,
 * so one hostile RPC node could serve a block holding an unsigned op "from
 * @morphit": the honest key lookup passed, its onion nodes joined the pool as
 * separate operators, and a forged release could move the treasury pin. And
 * when that lookup failed (an RPC blip) the handler threw, the dispatcher
 * committed the op as rejected, and that node lost a genuine release for good
 * while its peers recorded it.
 *
 * WHAT HAPPENS NOW. The signature is recovered from the transaction the block
 * carries and must equal the pinned `officialPostingPubkey`, for the configured
 * chain id. That is a pure function of the block and the pin: no chain read,
 * the same verdict on every node and on every replay, and nothing a node
 * without the key can forge. Which blocks are real is a separate question,
 * answered before the block is applied (fee/btcFeeBlockConfirm.ts: a block
 * holding either op is applied only when RPC operators (counted by node name) serve the
 * same transaction).
 */
import type { OpContext } from '$indexer/handler-contract';
import { recoverSigningKeys } from '$blurt/snapshotOpTrust';

export type OfficialOpDistrust = 'signer_not_official_account' | 'not_signed_by_pinned_key';

/** Null when the op is the official account's and its transaction is signed
 *  by the pinned key; otherwise why not. */
export function officialOpDistrust(
	ctx: Pick<OpContext, 'signer' | 'config' | 'transaction'>
): OfficialOpDistrust | null {
	if (ctx.signer !== ctx.config.officialAccountName) return 'signer_not_official_account';
	if (ctx.transaction === undefined) return 'not_signed_by_pinned_key';
	const keys = recoverSigningKeys(ctx.transaction, ctx.config.chainId);
	return keys.includes(ctx.config.officialPostingPubkey) ? null : 'not_signed_by_pinned_key';
}
