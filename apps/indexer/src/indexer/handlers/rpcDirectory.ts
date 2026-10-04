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
 *   2. the transaction carrying the op MUST be signed by the pinned
 *      config.officialPostingPubkey (recovered from the block's own
 *      transaction — see $indexer/officialOpTrust; no chain read).
 * Only then are the nodes merged. An impersonator (wrong account), an
 * unsigned op served by a hostile RPC node, or a signature from any other key
 * is rejected, so a forged directory can never inject attacker-controlled RPC
 * nodes into the pool.
 *
 * Merging is additive + idempotent (existing endpoints keep their health state),
 * and hidden endpoints are always reached via the routing dispatcher — clearnet
 * is unaffected. The pool merge is live (no restart). The latest trusted
 * directory is also stored (`rpc_directory`), and at boot it is proved against
 * the chain again before any of it joins the pool (rpcDirectoryReload.ts).
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { officialOpDistrust } from '$indexer/officialOpTrust';
import {
	validateRpcDirectoryPayload,
	directoryEndpointUrls,
	directoryNodeNameMap
} from '$blurt/rpcDirectoryOp';
import { logger } from '$log';

const log = logger('rpc-directory');

/**
 * Who runs each directory address: a node's
 * `.onion` and `.b32.i2p` are ONE operator, named by the node's name or, when
 * it has none, by its first address. The RPC quorum counts agreement per
 * operator; before this, a directory node's two addresses were two witnesses,
 * so one operator could meet a two-endpoint quorum by itself.
 */
export function directoryOperators(payload: {
	readonly nodes: ReadonlyArray<{
		readonly name?: string;
		readonly onion?: string;
		readonly i2p?: string;
	}>;
}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const n of payload.nodes) {
		const id = n.name || n.onion || n.i2p;
		if (!id) continue;
		if (n.onion) out[n.onion] = id;
		if (n.i2p) out[n.i2p] = id;
	}
	return out;
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validateRpcDirectoryPayload(ctx.payload);
	if (!v.ok) return { ok: false, reason: v.reason };

	// The official account, and a signature from the pinned key over the
	// transaction the block carries.
	const distrust = officialOpDistrust(ctx);
	if (distrust !== null) return { ok: false, reason: distrust };

	// Trusted → self-populate the hidden RPC pool with the directory's nodes.
	const endpoints = directoryEndpointUrls(v.payload);
	const nodeNames = directoryNodeNameMap(v.payload);
	const added = ctx.blurt.mergeRpcEndpoints(endpoints, directoryOperators(v.payload));
	if (added.length > 0) {
		log.info('rpc_directory_merged', { added: added.length, nodes: v.payload.nodes.length });
	}

	// Persist the latest trusted directory so directory-only nodes survive an
	// indexer restart (the pool merge above is in-memory only, and a restart
	// re-indexes FORWARD past an older op). Single row (id=1); latest-wins by
	// block, so a re-processed older op can't clobber a newer directory. The
	// optional per-node names ride in node_names (latest-wins with the rest).
	await client.query(
		`INSERT INTO rpc_directory (id, endpoints, node_count, published_ts, block_num, node_names)
		 VALUES (1, $1, $2, $3, $4, $5)
		 ON CONFLICT (id) DO UPDATE
		   SET endpoints = EXCLUDED.endpoints,
		       node_count = EXCLUDED.node_count,
		       published_ts = EXCLUDED.published_ts,
		       block_num = EXCLUDED.block_num,
		       node_names = EXCLUDED.node_names,
		       updated_at = now()
		   WHERE EXCLUDED.block_num >= rpc_directory.block_num`,
		[endpoints, v.payload.nodes.length, v.payload.ts, ctx.blockNum, JSON.stringify(nodeNames)]
	);
	return { ok: true };
};

export default handle;
