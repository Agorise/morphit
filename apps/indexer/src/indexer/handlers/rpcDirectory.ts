/**
 * Handler for `morphit_rpc_v1` — the on-chain RPC directory.
 *
 * @morphit publishes the canonical list of PUBLIC hidden-service Blurt RPC nodes
 * (Star, Jade, …). A trusting indexer reads it and MERGES those nodes into its
 * hidden-RPC pool at runtime, so a vetted node is picked up ecosystem-wide with
 * no code change or per-operator edit — the "automate it for the good nodes"
 * directory.
 *
 * Trust model is identical to the release handler (morphit_release_v1):
 *   1. signer MUST equal config.officialAccountName, AND
 *   2. that account's current on-chain posting pubkey MUST match the pinned
 *      config.officialPostingPubkey.
 * Only then are the nodes merged. An impersonator (wrong account) or a
 * key-compromise attempt (right account, wrong pubkey) is rejected, so a hostile
 * directory can never inject attacker-controlled RPC nodes into the pool.
 *
 * Merging is additive + idempotent (existing endpoints keep their health state),
 * and hidden endpoints are always reached via the routing dispatcher — clearnet
 * is unaffected. The pool merge is live (no restart); durable persistence across
 * a restart is a follow-up (the baked DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS always
 * seed Star/Jade regardless, so a restart never loses the core set).
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { resolveSignerPostingPubkey } from '$blurt/verify';
import { validateRpcDirectoryPayload, directoryEndpointUrls } from '$blurt/rpcDirectoryOp';
import { logger } from '$log';

const log = logger('rpc-directory');

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validateRpcDirectoryPayload(ctx.payload);
	if (!v.ok) return { ok: false, reason: v.reason };

	// Trust check 1: signer is the configured official account.
	if (ctx.signer !== ctx.config.officialAccountName) {
		return { ok: false, reason: 'signer_not_official_account' };
	}

	// Trust check 2: the signer's current on-chain posting pubkey matches the
	// pinned value. A chain-unreachable error re-throws so the dispatcher rolls
	// back + retries — we'd rather delay than trust an unverified directory.
	const account = await ctx.blurt.getAccount(ctx.signer, { userFacing: false });
	const chainPubkey = resolveSignerPostingPubkey(account);
	if (chainPubkey === null) return { ok: false, reason: 'signer_no_single_posting_key' };
	if (chainPubkey !== ctx.config.officialPostingPubkey) return { ok: false, reason: 'pubkey_mismatch' };

	// Trusted → self-populate the hidden RPC pool with the directory's nodes.
	const endpoints = directoryEndpointUrls(v.payload);
	const added = ctx.blurt.mergeRpcEndpoints(endpoints);
	if (added.length > 0) {
		log.info('rpc_directory_merged', { added: added.length, nodes: v.payload.nodes.length });
	}

	// Persist the latest trusted directory so directory-only nodes survive an
	// indexer restart (the pool merge above is in-memory only, and a restart
	// re-indexes FORWARD past an older op). Single row (id=1); latest-wins by
	// block, so a re-processed older op can't clobber a newer directory.
	await client.query(
		`INSERT INTO rpc_directory (id, endpoints, node_count, published_ts, block_num)
		 VALUES (1, $1, $2, $3, $4)
		 ON CONFLICT (id) DO UPDATE
		   SET endpoints = EXCLUDED.endpoints,
		       node_count = EXCLUDED.node_count,
		       published_ts = EXCLUDED.published_ts,
		       block_num = EXCLUDED.block_num,
		       updated_at = now()
		   WHERE EXCLUDED.block_num >= rpc_directory.block_num`,
		[endpoints, v.payload.nodes.length, v.payload.ts, ctx.blockNum]
	);
	return { ok: true };
};

export default handle;
