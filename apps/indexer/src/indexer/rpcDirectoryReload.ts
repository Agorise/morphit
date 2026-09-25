/**
 * Re-merge the persisted on-chain RPC directory at boot — only what the chain
 * proves (v1.18.0 deep-deep, rv2-4).
 *
 * WHAT WAS WRONG. On boot the indexer read `rpc_directory.endpoints` and merged
 * every URL into its live RPC pool as-is. The signer and pinned-key checks only
 * happen when the `morphit_rpc_v1` op is first indexed — and a snapshot restore
 * brings that table over verbatim, from someone else's database. Whatever URLs
 * the restored row held became permanent members of this node's pool: the
 * nodes its catch-up reads blocks from and its posting-key quorum asks.
 *
 * WHAT HAPPENS NOW. The row is only a pointer: its `block_num`. The block is
 * fetched from independent RPC operators that must agree on it, the directory
 * op in it must be signed by the pinned official posting key, and the endpoints
 * merged are the ones parsed from that signed op — never the row's copy. If the
 * agreed block holds no such signed op, the row is false and is deleted. If the
 * chain cannot be reached yet (a hidden-only node still building circuits),
 * nothing is merged and it tries again later; the baked default endpoints carry
 * the node meanwhile.
 */
import type { Database } from '$db/pool';
import type { BlurtClient } from '$blurt/client';
import type { Config } from '$config';
import { confirmSignedCustomJsonInBlock } from '$blurt/snapshotOpTrust';
import {
	RPC_DIRECTORY_OP_ID,
	directoryEndpointUrls,
	validateRpcDirectoryPayload
} from '$blurt/rpcDirectoryOp';
import { directoryOperators } from '$indexer/handlers/rpcDirectory';

export type DirectoryReloadOutcome =
	| { readonly kind: 'none' }
	| { readonly kind: 'merged'; readonly added: number }
	| { readonly kind: 'rejected' }
	| { readonly kind: 'unreachable' };

type Reader = Pick<BlurtClient, 'condenserAgreed' | 'mergeRpcEndpoints' | 'reachableOperatorCount'>;

export async function reloadVerifiedRpcDirectory(
	db: Pick<Database, 'query'>,
	blurt: Reader,
	config: Pick<Config, 'officialAccountName' | 'officialPostingPubkey' | 'chainId'>
): Promise<DirectoryReloadOutcome> {
	const dir = await db.query<{ block_num: string }>(
		`SELECT block_num::text FROM rpc_directory WHERE id = 1`
	);
	const row = dir.rows[0];
	if (row === undefined) return { kind: 'none' };
	const res = await confirmSignedCustomJsonInBlock(blurt, {
		blockNum: Number(row.block_num),
		opId: RPC_DIRECTORY_OP_ID,
		signer: config.officialAccountName,
		pinnedPubkey: config.officialPostingPubkey,
		chainId: config.chainId,
		minAgree: Math.min(2, Math.max(1, blurt.reachableOperatorCount()))
	});
	if (!res.ok && res.reason === 'no_quorum') return { kind: 'unreachable' };
	const v = res.ok ? validateRpcDirectoryPayload(res.payload) : null;
	if (v === null || !v.ok) {
		await db.query(`DELETE FROM rpc_directory WHERE id = 1 AND block_num = $1`, [row.block_num]);
		return { kind: 'rejected' };
	}
	const added = blurt.mergeRpcEndpoints(
		directoryEndpointUrls(v.payload),
		directoryOperators(v.payload)
	);
	return { kind: 'merged', added: added.length };
}

/**
 * Run {@link reloadVerifiedRpcDirectory} in the background until it reaches a
 * verdict: at once, then after 1, 2, 4 … minutes (capped at 30) while the chain
 * is unreachable. Never throws; the timer is unref'd. Returns a stop function.
 */
export function keepReloadingRpcDirectory(
	db: Pick<Database, 'query'>,
	blurt: Reader,
	config: Pick<Config, 'officialAccountName' | 'officialPostingPubkey' | 'chainId'>,
	onOutcome: (o: DirectoryReloadOutcome | { kind: 'error'; error: string }) => void
): () => void {
	let delay = 60_000;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const attempt = async (): Promise<void> => {
		if (stopped) return;
		let again = false;
		try {
			const o = await reloadVerifiedRpcDirectory(db, blurt, config);
			onOutcome(o);
			again = o.kind === 'unreachable';
		} catch (e) {
			onOutcome({ kind: 'error', error: e instanceof Error ? e.message : String(e) });
			again = true;
		}
		if (!again || stopped) return;
		timer = setTimeout(() => void attempt(), delay);
		timer.unref?.();
		delay = Math.min(delay * 2, 30 * 60_000);
	};
	void attempt();
	return () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
	};
}
