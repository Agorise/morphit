/**
 * v1.20.2 (E1) — full block verification, report-only (src/blurt/blockVerify.ts).
 *
 * The expected values were computed by a SEPARATE Python implementation
 * transcribed from steem's C++ (libraries/protocol/block.cpp
 * calculate_merkle_root and signed_block_header::id; transaction.cpp
 * signed_transaction::merkle_digest — fetched 2026-10-01), over the
 * transaction bytes dblurt serializes (whose ids also match dblurt's own
 * generateTrxId). No real Blurt block could be fetched where this was
 * written; that check is what report-only mode does on live nodes.
 */
import { describe, expect, it } from 'vitest';

import {
	BlockVerifyMonitor,
	checkBlock,
	computeBlockId,
	merkleRootOfDigests,
	transactionId,
	transactionMerkleDigest,
	type BlockLike
} from '$blurt/blockVerify';

const SIG = (c: string) => '1f' + c.repeat(128);
const TXS = [
	{
		ref_block_num: 41322,
		ref_block_prefix: 1914279617,
		expiration: '2026-10-01T19:40:30',
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['alice'],
					id: 'morphit_order_v1',
					json: '{"side":"sell"}'
				}
			]
		],
		extensions: [],
		signatures: [SIG('a')]
	},
	{
		ref_block_num: 41322,
		ref_block_prefix: 1914279617,
		expiration: '2026-10-01T19:40:33',
		operations: [['transfer', { from: 'bob', to: 'carol', amount: '1.500 BLURT', memo: 'thanks' }]],
		extensions: [],
		signatures: [SIG('b'), SIG('c')]
	},
	{
		ref_block_num: 41323,
		ref_block_prefix: 2040221934,
		expiration: '2026-10-01T19:40:36',
		operations: [
			['vote', { voter: 'dave', author: 'erin', permlink: 'hello-world', weight: 10000 }]
		],
		extensions: [],
		signatures: [SIG('d')]
	}
];
const IDS = [
	'e24f49026de372493448ace15f4b6f26c29fd545',
	'81276e3d6147c555f00dfa2faa1fc6c71ed730d6',
	'ddd5a9532e5a5d0d30b43810b0689912e11c7f1d'
];
const DIGESTS = [
	'ea62e03fb581d120e56213986c215319d2c458ec6837d2dd35e009d330a69752',
	'aaa26072c32a7fc4ed5ddbdb845cc95091ad4da6521f1ba358436d51f594e3be',
	'af73f92011d4bcbaa8eb767469ff92a0659c62fc0f4450ee6ba13d4f058f6ee2'
];
const ROOT3 = '9b1d0b9279a5f9886d4bb5ded67af37bd079ade0';
const PREV = '03d2a1b10000000000000000000000000000abcd'; // block 64135601
const HEADER = {
	previous: PREV,
	timestamp: '2026-10-01T19:40:27',
	witness: 'blurt-witness-one',
	witness_signature: '20' + '5e'.repeat(64)
};
const block = (o: Partial<BlockLike> = {}): BlockLike => ({
	...HEADER,
	transaction_merkle_root: ROOT3,
	extensions: [],
	block_id: '03d2a1b2e6816070a059d3bd02913f83da300015',
	transactions: TXS,
	transaction_ids: IDS,
	...o
});

describe('transactions', () => {
	it('ids and merkle digests (signed transaction) match the reference', () => {
		expect(TXS.map(transactionId)).toEqual(IDS);
		expect(TXS.map((t) => transactionMerkleDigest(t).toString('hex'))).toEqual(DIGESTS);
	});
});

describe('merkle root (calculate_merkle_root)', () => {
	const d = DIGESTS.map((h) => Buffer.from(h, 'hex'));
	it('one, two and three transactions (an odd last digest is carried up)', () => {
		expect(merkleRootOfDigests(d.slice(0, 1))).toBe('96d6ed261a904c90b5dad1acda3b7db7388c1dfb');
		expect(merkleRootOfDigests(d.slice(0, 2))).toBe('cb03253b6d216bff4af487620fe61ec51801d6d4');
		expect(merkleRootOfDigests(d)).toBe(ROOT3);
	});
	it('an empty block: twenty zero bytes', () => {
		expect(merkleRootOfDigests([])).toBe('0'.repeat(40));
	});
});

describe('block id (signed_block_header::id)', () => {
	it('no extensions; version; hardfork vote; empty block', () => {
		expect(computeBlockId(block())).toBe('03d2a1b2e6816070a059d3bd02913f83da300015');
		expect(computeBlockId(block({ extensions: [[1, '0.8.4']] }))).toBe(
			'03d2a1b2a5f8ea59b3283ed208fc387315c06533'
		);
		expect(
			computeBlockId(
				block({ extensions: [[2, { hf_version: '0.9.0', hf_time: '2026-11-01T00:00:00' }]] })
			)
		).toBe('03d2a1b2765c299d973e11b4a4e9aa5cbc33ead4');
		expect(computeBlockId(block({ transaction_merkle_root: '0'.repeat(40) }))).toBe(
			'03d2a1b20ac7931f1b8a29d8d049b4bee38729e2'
		);
	});
	it('starts with the block number, big-endian (previous + 1)', () => {
		expect(computeBlockId(block()).slice(0, 8)).toBe(
			(0x03d2a1b1 + 1).toString(16).padStart(8, '0')
		);
	});
});

describe('checkBlock', () => {
	it('a consistent block matches', () => {
		expect(checkBlock(block())).toEqual({
			kind: 'match',
			id: '03d2a1b2e6816070a059d3bd02913f83da300015'
		});
		expect(
			checkBlock(
				block({
					transactions: [],
					transaction_ids: [],
					transaction_merkle_root: '0'.repeat(40),
					block_id: '03d2a1b20ac7931f1b8a29d8d049b4bee38729e2'
				})
			).kind
		).toBe('match');
	});
	it('a changed operation whose id the node also changed: merkle mismatch', () => {
		const forged = structuredClone(TXS);
		(forged[1]!.operations[0]![1] as { to: string }).to = 'mallory';
		const r = checkBlock(
			block({ transactions: forged, transaction_ids: forged.map(transactionId) })
		);
		expect(r.kind).toBe('merkle_mismatch');
	});
	it('a stripped signature changes the merkle root (it is over SIGNED transactions)', () => {
		const forged = structuredClone(TXS);
		forged[1]!.signatures = [SIG('b')];
		expect(checkBlock(block({ transactions: forged })).kind).toBe('merkle_mismatch');
	});
	it('a served block_id that is not this header’s: id mismatch', () => {
		expect(checkBlock(block({ block_id: '03d2a1b2' + 'ff'.repeat(16) })).kind).toBe('id_mismatch');
	});
	it('a recomputed transaction id that differs from the node’s: reported as OURS (serializer), with the ops', () => {
		const r = checkBlock(block({ transaction_ids: [IDS[0], 'ab'.repeat(20), IDS[2]] }));
		expect(r).toEqual({ kind: 'txid_mismatch', index: 1, ops: ['transfer'] });
	});
	it('an operation dblurt cannot serialize is named, never a mismatch', () => {
		const odd = structuredClone(TXS);
		(odd[2] as { operations: unknown[] }).operations = [['some_new_op', { x: 1 }]];
		const r = checkBlock(block({ transactions: odd, transaction_ids: undefined }));
		expect(r).toMatchObject({ kind: 'unsupported', what: 'some_new_op' });
	});
	it('a header extension type it does not know is named too', () => {
		expect(checkBlock(block({ extensions: [[3, []]] }))).toMatchObject({
			kind: 'unsupported',
			what: 'extension'
		});
	});
});

describe('BlockVerifyMonitor — counts, never throws, checks links', () => {
	const id64135602 = '03d2a1b2e6816070a059d3bd02913f83da300015';
	it('follows the hash chain: the next block’s previous must be this one’s computed id', () => {
		const m = new BlockVerifyMonitor();
		m.observe(64135602, block());
		// the next block links to the computed id: a link checked and matching
		m.observe(64135603, {
			...block(),
			previous: id64135602,
			block_id: undefined
		});
		// a block that links somewhere else
		m.observe(64135604, { ...block(), previous: 'ab'.repeat(20), block_id: undefined });
		const s = m.stats();
		expect(s.checked).toBe(3);
		expect(s.linksChecked).toBe(2);
		expect(s.linkMismatch).toBe(1);
		expect(s.firstProblems.map((p) => p.kind)).toContain('link_mismatch');
	});
	it('counts kinds, names unsupported content, survives garbage', () => {
		const m = new BlockVerifyMonitor();
		m.observe(1, block());
		m.observe(2, block({ block_id: '00000002' + 'ff'.repeat(16) }));
		m.observe(3, block({ transaction_ids: ['ab'.repeat(20), IDS[1], IDS[2]] }));
		const odd = structuredClone(TXS);
		(odd[0] as { operations: unknown[] }).operations = [['some_new_op', {}]];
		m.observe(4, block({ transactions: odd, transaction_ids: undefined }));
		m.observe(5, { transactions: 'nope' } as unknown as BlockLike);
		m.observe(6, null);
		const s = m.stats();
		expect(s.mode).toBe('report-only');
		expect(s.matched).toBe(1);
		expect(s.idMismatch).toBe(1);
		expect(s.txidMismatch).toEqual({ custom_json: 1 });
		expect(s.unsupported.some_new_op).toBe(1);
		expect(s.checked).toBe(5);
	});
});
