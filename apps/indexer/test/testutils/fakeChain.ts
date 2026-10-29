/**
 * A small Blurt chain for tests that need real transaction ids: blocks of full
 * transactions (so transactionIdOf recomputes the id a node would serve), the
 * condenser get_block answer an RPC node gives for them, and a stand-in for
 * BlurtClient.condenserAgreed that
 * asks several "operators" and applies the agreement rule to the keys the code
 * under test computes — so a test can make one operator lie.
 */
import { transactionIdOf } from '../../src/blurt/snapshotOpTrust';

export type ChainOp = [string, Record<string, unknown>];

export interface FakeTransaction {
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
	operations: ChainOp[];
	extensions: unknown[];
	signatures: string[];
}

export interface FakeBlock {
	block_id: string;
	timestamp: string;
	transactions: FakeTransaction[];
	transaction_ids: string[];
}

let nonce = 1;

/** A transaction holding `ops`, unique by a counter. */
export function trx(ops: ChainOp[]): FakeTransaction {
	const n = nonce++;
	return {
		ref_block_num: n & 0xffff,
		ref_block_prefix: 1_000_000 + n,
		expiration: '2026-10-26T18:07:48',
		operations: ops,
		extensions: [],
		signatures: []
	};
}

export const customJson = (signer: string, id: string, json: unknown): ChainOp => [
	'custom_json',
	{ required_auths: [], required_posting_auths: [signer], id, json: JSON.stringify(json) }
];

export const transfer = (from: string, to: string, amount: string, memo = ''): ChainOp => [
	'transfer',
	{ from, to, amount, memo }
];

/** Blurt block timestamps carry no zone (UTC). */
export const chainStamp = (d: Date): string => d.toISOString().slice(0, 19);

/** A block at `time` with ids computed as a node computes them. */
export function block(blockNum: number, time: Date, txs: FakeTransaction[]): FakeBlock {
	return {
		block_id: blockNum.toString(16).padStart(8, '0').padEnd(40, 'a'),
		timestamp: chainStamp(time),
		transactions: txs,
		transaction_ids: txs.map((t) => {
			const id = transactionIdOf(t);
			if (id === null) throw new Error('fakeChain: transaction id not computable');
			return id;
		})
	};
}

/** One RPC node's answers over `blocks` (get_block). */
export class FakeNode {
	constructor(readonly blocks: ReadonlyMap<number, FakeBlock>) {}

	getBlock(n: number): FakeBlock | null {
		return this.blocks.get(n) ?? null;
	}

	/** condenser_api answers for the method the code under test reads. */
	call(method: string, params: readonly unknown[]): unknown {
		if (method === 'get_block') return this.getBlock(params[0] as number);
		throw new Error(`fakeChain: ${method} not served`);
	}
}

/** The agreement rule, as BlurtClient.condenserAgreed applies it: an answer
 *  counts when `keyOf` gives it a key; the value decided is the first answer
 *  of a key held by at least `minAgree` operators AND a strict majority of
 *  those that counted. */
export function agreedReader(
	operators: readonly ((method: string, params: readonly unknown[]) => unknown)[],
	quorum: number
): {
	condenserAgreed<T>(
		method: string,
		params: readonly unknown[],
		keyOf: (answer: T) => string | null,
		minAgree: number
	): Promise<{ value: T; key: string } | null>;
	trustedQuorumSize(): number;
	calls: Array<{ method: string; params: readonly unknown[]; minAgree: number }>;
} {
	const calls: Array<{ method: string; params: readonly unknown[]; minAgree: number }> = [];
	return {
		calls,
		trustedQuorumSize: () => quorum,
		async condenserAgreed<T>(
			method: string,
			params: readonly unknown[],
			keyOf: (answer: T) => string | null,
			minAgree: number
		) {
			calls.push({ method, params, minAgree });
			const votes: Array<{ key: string; value: T }> = [];
			for (const op of operators) {
				let answer: T;
				try {
					answer = op(method, params) as T;
				} catch {
					continue; // a failed read is no answer
				}
				const key = keyOf(answer);
				if (key !== null) votes.push({ key, value: answer });
			}
			const counts = new Map<string, number>();
			for (const v of votes) counts.set(v.key, (counts.get(v.key) ?? 0) + 1);
			for (const v of votes) {
				const c = counts.get(v.key)!;
				if (c >= minAgree && c * 2 > votes.length) return { value: v.value, key: v.key };
			}
			return null;
		}
	};
}
