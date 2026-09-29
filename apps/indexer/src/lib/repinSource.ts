/**
 * Morphit — where the treasury re-pin tool takes the CURRENT release op from
 * (v1.20.0, V3-1).
 *
 * treasury-repin-broadcast.ts used to rebuild the next release op from one
 * indexer's /v1/release. A node that indexed the pin release while still on
 * v1.19 serves the treasury rebuilt from the fields v1.19 knew — no
 * `btc.xpub`, no `xmr.primary_address` — and the re-pin would have broadcast
 * that, dropping the per-order address key and the XMR binding for EVERY
 * instance. It also dropped every top-level field it did not list
 * (`distribution`).
 *
 * Now: /v1/release only says WHICH op is current (source_block_num,
 * source_trx_id); the op itself is read from the block, from two RPC
 * operators that must return the same payload; the served treasury must equal
 * the chain op's (validated) treasury or the tool refuses and names what the
 * node is missing; and the next op keeps every field of the chain op except
 * the treasury amounts it re-prices.
 */
import { validateReleasePayload, type ReleaseTreasuryBlock } from '@morphit/release-schema';

import { parseReleaseTreasury } from './treasuryRepin.ts';

type Block = { transaction_ids?: unknown; transactions?: unknown };

/** The payload of `signer`'s morphit_release_v1 op in transaction `trxId`. */
export function findReleaseOpPayload(
	block: unknown,
	trxId: string,
	signer: string
): unknown | null {
	const b = block as Block | null;
	if (b === null || !Array.isArray(b.transaction_ids) || !Array.isArray(b.transactions))
		return null;
	const i = (b.transaction_ids as unknown[]).indexOf(trxId);
	if (i < 0) return null;
	const trx = b.transactions[i] as { operations?: unknown } | undefined;
	for (const op of Array.isArray(trx?.operations) ? trx!.operations : []) {
		if (!Array.isArray(op) || op[0] !== 'custom_json') continue;
		const body = op[1] as {
			id?: unknown;
			json?: unknown;
			required_posting_auths?: unknown;
			required_auths?: unknown;
		};
		if (body?.id !== 'morphit_release_v1' || typeof body.json !== 'string') continue;
		const auths = [
			...(Array.isArray(body.required_posting_auths) ? body.required_posting_auths : []),
			...(Array.isArray(body.required_auths) ? body.required_auths : [])
		];
		if (!auths.includes(signer)) continue;
		try {
			return JSON.parse(body.json);
		} catch {
			return null;
		}
	}
	return null;
}

function leaves(v: unknown, prefix: string, out: Map<string, string>): void {
	if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
		for (const [k, x] of Object.entries(v as Record<string, unknown>))
			leaves(x, `${prefix}.${k}`, out);
		return;
	}
	if (v === null || v === undefined) return;
	out.set(prefix, JSON.stringify(v));
}

export type ServedCheck =
	| {
			readonly ok: true;
			/** The chain op's fields, minus `treasury` and `signature`, to carry
			 *  into the next release op. */
			readonly base: Record<string, unknown>;
			/** The chain op's treasury, validated (canonical key spellings). */
			readonly chainTreasury: ReleaseTreasuryBlock;
	  }
	| { readonly ok: false; readonly reason: string; readonly missing: readonly string[] };

/** Does the node's /v1/release agree with the release op on chain? */
export function checkServedAgainstChain(served: unknown, chainPayload: unknown): ServedCheck {
	const v = validateReleasePayload(chainPayload);
	if (!v.ok)
		return {
			ok: false,
			reason: `the release op on chain does not validate (${v.reason})`,
			missing: []
		};
	const chainTreasury = v.value.treasury ?? null;
	if (chainTreasury === null)
		return { ok: false, reason: 'the release op on chain has no treasury', missing: [] };
	const s = (served ?? {}) as { version?: unknown; treasury?: unknown };
	if (s.version !== v.value.version) {
		return {
			ok: false,
			reason: `the node serves version ${String(s.version)}, the chain op is ${v.value.version}`,
			missing: []
		};
	}
	const want = new Map<string, string>();
	const got = new Map<string, string>();
	leaves(chainTreasury, 'treasury', want);
	leaves(s.treasury, 'treasury', got);
	const missing = [...want.entries()].filter(([k, x]) => got.get(k) !== x).map(([k]) => k);
	const a = parseReleaseTreasury(chainTreasury);
	const b = parseReleaseTreasury(s.treasury ?? null);
	const same =
		JSON.stringify(a, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) ===
		JSON.stringify(b, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
	if (missing.length > 0 || !same) {
		return {
			ok: false,
			reason:
				'the node serves a treasury that differs from the release op on chain (was it indexed by an older version?)',
			missing
		};
	}
	const base: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(chainPayload as Record<string, unknown>)) {
		if (k !== 'treasury' && k !== 'signature') base[k] = x;
	}
	return { ok: true, base, chainTreasury };
}

/** One condenser JSON-RPC call; the result body (`{ result }`). */
export type RpcPost = (url: string, body: unknown) => Promise<{ result?: unknown }>;

/** Read the release op from the block, from at least two RPC endpoints that
 *  return the SAME payload. Anything less is a refusal, never a guess. */
export async function fetchReleasePayloadFromChain(
	blockNum: number,
	trxId: string,
	signer: string,
	endpoints: readonly string[],
	post: RpcPost
): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }> {
	const answers: string[] = [];
	let payload: unknown = null;
	for (const url of endpoints) {
		try {
			const r = await post(url, {
				jsonrpc: '2.0',
				id: 1,
				method: 'condenser_api.get_block',
				params: [blockNum]
			});
			const p = findReleaseOpPayload(r.result, trxId, signer);
			if (p === null) continue;
			const key = JSON.stringify(p);
			if (answers.length > 0 && !answers.includes(key)) {
				return {
					ok: false,
					reason: `RPC endpoints disagree about the release op in block ${blockNum}`
				};
			}
			answers.push(key);
			payload = p;
			if (answers.length >= 2) return { ok: true, payload };
		} catch {
			// next endpoint
		}
	}
	return {
		ok: false,
		reason: `fewer than two RPC endpoints returned the release op in block ${blockNum}`
	};
}
