/**
 * Morphit — on-chain RPC-directory op builder + validator (v1.12.0).
 *
 * `@morphit` publishes the canonical list of PUBLIC hidden-service Blurt RPC
 * nodes (Star, Jade, …) as a `custom_json` op with id `morphit_rpc_v1`. Every
 * indexer that trusts `@morphit` reads the latest such op and merges those nodes
 * into its hidden-RPC pool — so a good node can be added ecosystem-wide WITHOUT
 * a code change or a per-operator edit. This is the "automate it for the good
 * nodes" directory.
 *
 * Trust model = identical to `morphit_release_v1`: the op is only honoured when
 * (1) the signer is the configured official account and (2) that account's
 * on-chain posting pubkey matches the pinned value (checked in the handler).
 * This file is the PURE, network-free, key-free core: it validates the payload
 * (the same rules the indexer enforces), and shapes the exact `custom_json` op
 * params to sign with the `@morphit` posting WIF. Keeping it separate means the
 * schema + op shape are typechecked and unit-tested, while the CLI is left with
 * only the unavoidable bits (masked key prompt, live broadcast).
 */

/** custom_json op id. Frozen — the indexer handler + the broadcast CLI both key
 *  on this. */
export const RPC_DIRECTORY_OP_ID = 'morphit_rpc_v1';

/** Default signer — the canonical @morphit account (overridable for tests / a
 *  community fork running its own trust anchor). */
export const RPC_DIRECTORY_SIGNER_DEFAULT = 'morphit';

/** Same hard Blurt limit the release op uses: a custom_json `json` field must be
 *  under this many bytes or every node rejects the broadcast. */
export const BLURT_CUSTOM_JSON_MAX_BYTES = 8192;

/** Caps — keep the directory small (it's chain-bloat) and bounded. */
export const RPC_DIRECTORY_MAX_NODES = 32;

/** One node in the directory: at least one hidden-service address. Both forms
 *  are optional but at least one is required. Deliberately NO label/name field —
 *  a human name would leak identifying metadata onto the public chain and is
 *  never used functionally (nodes are keyed purely by their opaque address). */
export interface RpcDirectoryNode {
	readonly onion?: string;
	readonly i2p?: string;
}

/** The `json` payload of a `morphit_rpc_v1` op. */
export interface RpcDirectoryPayload {
	readonly v: 1;
	readonly nodes: readonly RpcDirectoryNode[];
	/** ISO-8601 publish time — lets a consumer prefer the freshest directory. */
	readonly ts: string;
}

/** The exact shape `broadcast.customJson(data, key)` expects. */
export interface RpcDirectoryCustomJsonOp {
	readonly required_auths: readonly string[];
	readonly required_posting_auths: readonly string[];
	readonly id: string;
	readonly json: string;
}

export type ValidateResult =
	| { readonly ok: true; readonly payload: RpcDirectoryPayload }
	| { readonly ok: false; readonly reason: string };

/** True for a well-formed hidden-service RPC URL: `http://<host>.onion:port` or
 *  `http://<host>.b32.i2p:port`. TLS is meaningless on a self-authenticating
 *  transport, so http:// (not https). PURE. */
export function isHiddenRpcUrl(u: string, kind: 'onion' | 'i2p'): boolean {
	let url: URL;
	try {
		url = new URL(u);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:') return false;
	const h = url.hostname.toLowerCase();
	return kind === 'onion' ? h.endsWith('.onion') : h.endsWith('.i2p');
}

/** Validate a parsed `morphit_rpc_v1` payload. PURE + total — never throws.
 *  Enforces the SAME rules the indexer handler applies, so the broadcast CLI
 *  can reject a bad directory up front instead of after the key is pasted. */
export function validateRpcDirectoryPayload(input: unknown): ValidateResult {
	if (input === null || typeof input !== 'object') return { ok: false, reason: 'not_an_object' };
	const p = input as Record<string, unknown>;
	if (p.v !== 1) return { ok: false, reason: 'unsupported_version' };
	if (typeof p.ts !== 'string' || Number.isNaN(Date.parse(p.ts)))
		return { ok: false, reason: 'bad_or_missing_ts' };
	if (!Array.isArray(p.nodes)) return { ok: false, reason: 'nodes_not_an_array' };
	if (p.nodes.length === 0) return { ok: false, reason: 'nodes_empty' };
	if (p.nodes.length > RPC_DIRECTORY_MAX_NODES) return { ok: false, reason: 'too_many_nodes' };

	const nodes: RpcDirectoryNode[] = [];
	for (const raw of p.nodes) {
		if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'node_not_an_object' };
		const n = raw as Record<string, unknown>;
		const onion = n.onion;
		const i2p = n.i2p;
		if (onion !== undefined && (typeof onion !== 'string' || !isHiddenRpcUrl(onion, 'onion')))
			return { ok: false, reason: 'bad_onion_url' };
		if (i2p !== undefined && (typeof i2p !== 'string' || !isHiddenRpcUrl(i2p, 'i2p')))
			return { ok: false, reason: 'bad_i2p_url' };
		if (onion === undefined && i2p === undefined) return { ok: false, reason: 'node_has_no_address' };
		nodes.push({
			...(typeof onion === 'string' ? { onion } : {}),
			...(typeof i2p === 'string' ? { i2p } : {})
		});
	}

	const payload: RpcDirectoryPayload = { v: 1, nodes, ts: p.ts };
	if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > BLURT_CUSTOM_JSON_MAX_BYTES)
		return { ok: false, reason: 'payload_too_large' };
	return { ok: true, payload };
}

/** Flatten a directory into the de-duplicated list of RPC endpoint URLs (onion
 *  first, then i2p) for merging into the hidden pool. PURE. */
export function directoryEndpointUrls(payload: RpcDirectoryPayload): string[] {
	const urls: string[] = [];
	for (const n of payload.nodes) if (n.onion) urls.push(n.onion);
	for (const n of payload.nodes) if (n.i2p) urls.push(n.i2p);
	return [...new Set(urls)];
}

/** Build the exact `custom_json` op to sign with the @morphit posting WIF.
 *  Validates first (throws on an invalid payload — the CLI catches and prints
 *  the reason before ever touching a key). PURE. */
export function buildRpcDirectoryCustomJsonOp(
	input: unknown,
	signer: string = RPC_DIRECTORY_SIGNER_DEFAULT
): RpcDirectoryCustomJsonOp {
	const v = validateRpcDirectoryPayload(input);
	if (!v.ok) throw new Error(`invalid rpc-directory payload: ${v.reason}`);
	return {
		required_auths: [],
		required_posting_auths: [signer],
		id: RPC_DIRECTORY_OP_ID,
		json: JSON.stringify(v.payload)
	};
}
