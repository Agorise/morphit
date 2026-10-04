/**
 * A tiny in-process Blurt chain + JSON-RPC nodes for relay smokes (v1.20.0
 * 4). Adapted from the independent verifier's harness (scratchpad
 * V2/fakechain.ts). Every node shares one chain; each node's behaviour is
 * mutable so a scenario can make one hang, lie, lag, or lose replies.
 *
 * Model: a node that ACCEPTS a transaction puts it in `pending` (it was relayed
 * to the network) or straight into a block; `includePending()` seals every
 * still-valid pending transaction into a block. History, accounts and the
 * irreversible block are derived from the included transactions, per node
 * (a lagging node sees the chain as it was `lagSec` ago).
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { cryptoUtils } from '@beblurt/dblurt';

export type Bcast =
	| 'ok'
	| 'accept-hang' // takes it (relays it), never answers
	| 'hang' // down: no answer, never took it
	| { reject: string } // refuses it, did not take it
	| { relayThenReject: string }; // hostile: takes it AND says it refused
export interface NodeBehaviour {
	bcast: Bcast;
	dgpHang?: boolean;
	historyHang?: boolean;
	noHistoryApi?: boolean;
	lagSec?: number;
	delayMs?: number;
	/** The node has not seen what other nodes relayed (a partitioned or
	 *  lagging node): it does not answer "duplicate" for them. */
	noDupCheck?: boolean;
}
export interface Included {
	txid: string;
	op: [string, Record<string, unknown>];
	time: string;
	block: number;
}
export interface FakeChain {
	pending: Map<string, { expiration: string; operations: [string, Record<string, unknown>][] }>;
	included: Included[];
	libGapBlocks: number;
	includeTx(
		txid: string,
		tx: { operations: [string, Record<string, unknown>][] },
		blockOffset?: number
	): void;
	includePending(): number;
	transfersTo(to: string): Included[];
	accountsCreated(): Included[];
}
export function headNum(): number {
	return Math.floor(Date.now() / 3000);
}
function isoNoZ(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19);
}
export function newChain(): FakeChain {
	const c: FakeChain = {
		pending: new Map(),
		included: [],
		libGapBlocks: 15,
		includeTx(txid, tx, blockOffset = 0) {
			const b = headNum() + blockOffset;
			for (const op of tx.operations)
				c.included.push({ txid, op, time: isoNoZ(b * 3000), block: b });
			c.pending.delete(txid);
		},
		includePending() {
			let n = 0;
			for (const [id, tx] of c.pending) {
				if (Date.now() <= new Date(tx.expiration + 'Z').getTime()) {
					c.includeTx(id, tx);
					n++;
				} else c.pending.delete(id);
			}
			return n;
		},
		transfersTo(to) {
			return c.included.filter(
				(i) => (i.op[0] === 'transfer' || i.op[0] === 'transfer_to_vesting') && i.op[1].to === to
			);
		},
		accountsCreated() {
			return c.included.filter((i) => i.op[0] === 'account_create');
		}
	};
	return c;
}

export interface FakeNode {
	url: string;
	b: NodeBehaviour;
	hits: Record<string, number>;
	close: () => void;
}
/** Each node listens on its own loopback address (127.0.0.2, .3, …): the RPC
 *  pool counts OPERATORS by host, and a quorum needs distinct ones. */
let nextHost = 2;
export async function startNode(chain: FakeChain, b: NodeBehaviour): Promise<FakeNode> {
	const host = `127.0.0.${nextHost++ % 250 || 2}`;
	const hits: Record<string, number> = {};
	const sockets = new Set<Socket>();
	const srv = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', async () => {
			if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
			let j: { id: number; method: string; params: unknown[] };
			try {
				j = JSON.parse(body);
			} catch {
				res.end('{}');
				return;
			}
			const m = j.method;
			hits[m] = (hits[m] ?? 0) + 1;
			const reply = (result: unknown): void => {
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
			};
			const err = (message: string): void => {
				res.setHeader('content-type', 'application/json');
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: j.id,
						error: { code: -32000, message, data: { code: 10, name: 'assert_exception', message } }
					})
				);
			};
			const lagBlocks = Math.round((b.lagSec ?? 0) / 3);
			const head = headNum() - lagBlocks;
			if (m.endsWith('get_dynamic_global_properties')) {
				if (b.dgpHang) return;
				return reply({
					head_block_number: head,
					head_block_id: head.toString(16).padStart(8, '0') + 'ab'.repeat(16),
					time: isoNoZ(head * 3000),
					last_irreversible_block_num: head - chain.libGapBlocks,
					total_vesting_fund_blurt: '1000.000 BLURT',
					total_vesting_shares: '2000000.000000 VESTS'
				});
			}
			if (m.endsWith('broadcast_transaction') || m.endsWith('broadcast_transaction_synchronous')) {
				const tx = j.params[0] as {
					expiration: string;
					operations: [string, Record<string, unknown>][];
				};
				const txid = cryptoUtils.generateTrxId(tx as never);
				if (b.bcast === 'hang') return;
				if (
					!b.noDupCheck &&
					(chain.pending.has(txid) || chain.included.some((i) => i.txid === txid))
				)
					return err('Duplicate transaction check failed');
				if (b.bcast === 'accept-hang') {
					chain.pending.set(txid, tx);
					return;
				}
				if (b.bcast === 'ok') {
					for (const [op, body2] of tx.operations) {
						if (
							op === 'account_create' &&
							chain
								.accountsCreated()
								.some((i) => i.op[1].new_account_name === body2.new_account_name)
						)
							return err(
								'could not insert object, most likely a uniqueness constraint was violated'
							);
					}
					chain.includeTx(txid, tx);
					return reply({});
				}
				if ('relayThenReject' in b.bcast) {
					chain.includeTx(txid, tx);
					return err(b.bcast.relayThenReject);
				}
				return err(b.bcast.reject);
			}
			if (m.endsWith('get_chain_properties'))
				return reply({ account_creation_fee: '100.000 BLURT', maximum_block_size: 65536 });
			if (m.endsWith('get_accounts')) {
				const names = j.params[0] as string[];
				return reply(
					chain
						.accountsCreated()
						.filter((i) => i.block <= head && names.includes(i.op[1].new_account_name as string))
						.map((i) => ({
							name: i.op[1].new_account_name,
							owner: i.op[1].owner,
							posting: i.op[1].posting,
							balance: '0.000 BLURT',
							created: i.time
						}))
				);
			}
			if (m.endsWith('get_account_history')) {
				if (b.historyHang) return;
				if (b.noHistoryApi)
					return err('Assert Exception:false: Could not find API account_history_api');
				const acct = j.params[0] as string;
				// History is only indexed up to the node's irreversible block.
				const upTo = head - chain.libGapBlocks;
				const mine = chain.included.filter(
					(i) => (i.op[1].from === acct || i.op[1].to === acct) && i.block <= upTo
				);
				const rows: unknown[] = [
					[
						0,
						{
							trx_id: '0'.repeat(40),
							block: 1,
							timestamp: isoNoZ(Date.now() - 3 * 3600_000),
							op: ['transfer', { from: 'someone', to: acct, amount: '1.000 BLURT', memo: '' }]
						}
					]
				];
				mine.forEach((i, k) =>
					rows.push([k + 1, { trx_id: i.txid, block: i.block, timestamp: i.time, op: i.op }])
				);
				return reply(rows);
			}
			return err('unknown method ' + m);
		});
	});
	srv.on('connection', (s) => {
		sockets.add(s);
		s.on('close', () => sockets.delete(s));
	});
	await new Promise<void>((r) => srv.listen(0, host, () => r()));
	return {
		url: `http://${host}:${(srv.address() as AddressInfo).port}`,
		b,
		hits,
		close: () => {
			for (const s of sockets) s.destroy();
			srv.close();
		}
	};
}
