/**
 * Morphit — Blurt chain client.
 *
 * Wraps the `dblurt` library (community fork of dhive/dsteem) so that
 * every JSON-RPC call it makes routes through Morphit's endpoint
 * rotator. dblurt is used for ITS operation builders and signing
 * primitives, but its transport is replaced — dblurt thinks it's
 * talking to a single "morphit-internal" URL, which our client
 * intercepts via the fetch shim on `Client`'s `address` parameter.
 *
 * Phase 2a exposes read-only helpers:
 *   - getAccount(name) — fetch a Blurt account's public keys + metadata
 *   - getDynamicGlobalProperties() — chain head info (for ref_block_num)
 *   - getLatestCustomJson(account, id) — most recent op of a given type
 *
 * Phase 2b adds:
 *   - broadcastCustomJson(op, postingKey) — sign + broadcast a morphit op
 *
 * Everything here is client-side; there is no server component.
 */

import { getRotator, type EndpointRotator } from '$net/endpoints';

// ────────────────────────────────────────────────────────────────────────────
// Types (mirror Blurt's blockchain JSON shapes)
// ────────────────────────────────────────────────────────────────────────────

export interface BlurtAuthority {
	weight_threshold: number;
	account_auths: Array<[string, number]>;
	key_auths: Array<[string, number]>;
}

export interface BlurtAccount {
	id: number;
	name: string;
	owner: BlurtAuthority;
	active: BlurtAuthority;
	posting: BlurtAuthority;
	memo_key: string;
	json_metadata: string;
	posting_json_metadata: string;
	created: string;
	last_account_update: string;
	reputation: string | number;
	/** Liquid BLURT balance ("42.123 BLURT" format).  Optional in
	 *  the type because some legacy code paths fetch with a field
	 *  filter; new callers that need balances should not filter
	 *  these out. */
	balance?: string;
	/** Powered-up stake as VESTS ("1000000.123456 VESTS" format).
	 *  Convert to BLURT POWER via balanceMath.vestsToBlurtPower. */
	vesting_shares?: string;
	/** Voting MANA regen state.  See balanceMath.manaPercentage. */
	voting_manabar?: {
		current_mana: string;
		last_update_time: number;
	};
}

export interface DynamicGlobalProperties {
	head_block_number: number;
	head_block_id: string;
	time: string;
	current_witness: string;
	total_vesting_fund_blurt: string;
	total_vesting_shares: string;
	current_supply: string;
	virtual_supply: string;
}

export interface CustomJsonOp {
	required_auths: string[];
	required_posting_auths: string[];
	id: string;
	json: string;
}

export interface ChainOperation {
	block: number;
	trx_id: string;
	trx_in_block: number;
	op_in_trx: number;
	timestamp: string;
	/** [opName, opPayload] shape — Blurt inherits this from Graphene. */
	op: [string, Record<string, unknown>];
}

// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────

export class BlurtClient {
	/**
	 * Rotator is resolved fresh on each call rather than cached, so that
	 * a user editing endpoints in Settings (which calls `refreshRotator()`)
	 * takes effect immediately without needing to re-create this client.
	 */
	constructor(private readonly rotatorOverride?: EndpointRotator) {}

	private get rotator(): EndpointRotator {
		return this.rotatorOverride ?? getRotator();
	}

	/**
	 * Look up a single account by name. Returns null if the account
	 * doesn't exist on-chain (common case: display-name resolution for a
	 * public key that hasn't been registered yet).
	 */
	async getAccount(name: string): Promise<BlurtAccount | null> {
		const result = await this.rotator.call<BlurtAccount[]>('condenser_api.get_accounts', [[name]]);
		return result.length > 0 ? result[0]! : null;
	}

	/** Fetch chain head info — needed for transaction ref_block_num. */
	async getDynamicGlobalProperties(): Promise<DynamicGlobalProperties> {
		return this.rotator.call<DynamicGlobalProperties>(
			'condenser_api.get_dynamic_global_properties'
		);
	}

	/**
	 * Fetch the most recent `custom_json` op with the given id authored
	 * by `account`. Returns null if none exists in the window the node
	 * indexes (nodes retain limited history — Phase 3 indexer fills this
	 * gap).
	 *
	 * `limit` controls how many history entries the call walks (default
	 * 500).  For verification flows where the target op may be deep in
	 * history (e.g. a chat-identity op published months ago by an
	 * active account), callers should pass a larger value.  Blurt's
	 * `get_account_history` accepts up to 10,000 per call.
	 *
	 * This is a READ-ONLY best-effort helper. For canonical Morphit-op
	 * history, Phase 3 uses the indexer which tracks every op
	 * indefinitely.
	 */
	async getLatestCustomJson<T = unknown>(
		account: string,
		opId: string,
		limit = 500
	): Promise<{
		payload: T;
		blockNumber: number;
		trxId: string;
		timestamp: string;
	} | null> {
		// condenser_api.get_account_history returns operations in
		// reverse-chronological order when `from = -1`.
		type HistoryEntry = [number, ChainOperation];
		const history = await this.rotator.call<HistoryEntry[]>('condenser_api.get_account_history', [
			account,
			-1,
			limit
		]);
		// History is ordered oldest-first even with from=-1; walk backwards.
		for (let i = history.length - 1; i >= 0; i--) {
			const entry = history[i]!;
			const op = entry[1];
			const [opName, opBody] = op.op;
			if (opName !== 'custom_json') continue;
			const cj = opBody as unknown as CustomJsonOp;
			if (cj.id !== opId) continue;
			const authedBy = [...cj.required_auths, ...cj.required_posting_auths];
			if (!authedBy.includes(account)) continue;
			try {
				const payload = JSON.parse(cj.json) as T;
				return {
					payload,
					blockNumber: op.block,
					trxId: op.trx_id,
					timestamp: op.timestamp
				};
			} catch {
				continue;
			}
		}
		return null;
	}

	/** Raw JSON-RPC call, escape hatch for Phase 2b/3 code. */
	async call<T = unknown>(method: string, params?: unknown): Promise<T> {
		return this.rotator.call<T>(method, params);
	}

	/** Fetch a Blurt block by number.  Returns the block's
	 *  transactions, witness, timestamp, etc.  Used by the
	 *  block explorer (Batch K).  Returns null if the block
	 *  doesn't exist (number > head, future block, etc.) — the
	 *  chain RPC returns an empty / null body in those cases.
	 *
	 *  The shape returned is condenser_api.get_block's:
	 *    {
	 *      previous, timestamp, witness, transaction_merkle_root,
	 *      extensions, witness_signature,
	 *      transactions: [<tx body>...],
	 *      block_id, signing_key, transaction_ids: [<trxId>...]
	 *    }
	 */
	async getBlock(blockNumber: number): Promise<BlurtBlock | null> {
		const result = await this.rotator.call<BlurtBlock | null>('condenser_api.get_block', [
			blockNumber
		]);
		return result ?? null;
	}

	/** Fetch a Blurt transaction by its trx_id.  Used by the
	 *  block explorer to surface a tx's details given just an
	 *  id from another page.  Returns null if not found.
	 *
	 *  Note: NOT all Blurt RPC nodes expose transaction lookup
	 *  by id (it requires a non-default tx-index plugin on the
	 *  node).  Callers should handle null gracefully and fall
	 *  back to "view on blocks.blurtwallet.com" if needed. */
	async getTransaction(trxId: string): Promise<BlurtTransaction | null> {
		try {
			const result = await this.rotator.call<BlurtTransaction | null>(
				'condenser_api.get_transaction',
				[trxId]
			);
			return result ?? null;
		} catch {
			// RPC nodes without the tx-index plugin throw on this
			// call.  Return null so the UI can show the fallback.
			return null;
		}
	}
}

/** A Blurt block as returned by `condenser_api.get_block`.
 *  Field names match the chain's wire format exactly. */
export interface BlurtBlock {
	previous: string;
	timestamp: string;
	witness: string;
	transaction_merkle_root: string;
	extensions: unknown[];
	witness_signature: string;
	transactions: BlurtTransaction[];
	block_id: string;
	signing_key: string;
	transaction_ids: string[];
}

/** A Blurt transaction (as part of a block, or fetched standalone). */
export interface BlurtTransaction {
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
	operations: Array<[string, Record<string, unknown>]>;
	extensions: unknown[];
	signatures: string[];
	transaction_id?: string;
	block_num?: number;
	transaction_num?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Singleton
// ────────────────────────────────────────────────────────────────────────────

let singleton: BlurtClient | null = null;

export function getBlurtClient(): BlurtClient {
	if (!singleton) singleton = new BlurtClient();
	return singleton;
}
