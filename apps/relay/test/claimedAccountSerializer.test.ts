/**
 * claimedAccountSerializers byte cross-check — cp324.
 *
 * Proves the augmented Types.Transaction (which teaches dblurt to
 * serialize claim_account + create_claimed_account) is SAFE and CORRECT
 * without a live chain:
 *
 *   1. Stock dblurt genuinely cannot serialize the two ops (documents the
 *      bug the fix targets).
 *   2. For every EXISTING op (transfer, account_create) the augmented
 *      serializer is byte-for-byte identical to stock dblurt — so the
 *      global Types.Transaction swap cannot regress any other broadcast.
 *   3. The two new ops now serialize, carrying the correct op-ids (15/16).
 *   4. create_claimed_account's field bytes equal account_create's shared
 *      fields exactly (same encoders, same order) — the only structural
 *      differences are the op-id, the absence of `fee`, and the trailing
 *      `extensions`, all confirmed from the chain's op definitions.
 *
 * What remains for a live test on the relay host: that the chain ACCEPTS
 * the signed op (op-id + layout match Blurt's expectations). Items 2-4
 * reduce that to a near-formality.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// bytebuffer (a dblurt transitive dep) ships no type declarations; we use
// it only to obtain a raw serialization buffer and cast to any at the call
// site. No new dependency is added for this.
// @ts-expect-error - bytebuffer has no bundled types
import ByteBuffer from 'bytebuffer';
import { Types, PrivateKey } from '@beblurt/dblurt';
import {
	registerClaimedAccountOperationSerializers,
	claimAccountSerializer,
	createClaimedAccountSerializer,
	CLAIM_ACCOUNT_OP_ID,
	CREATE_CLAIMED_ACCOUNT_OP_ID
} from '../src/blurt/claimedAccountSerializers.ts';

type Ser = (buffer: unknown, data: unknown) => void;

// Capture stock dblurt's Transaction serializer BEFORE we register, so we
// can prove (a) it throws for our ops and (b) byte-identity for known ops.
const stockTransaction = (Types as unknown as { Transaction: Ser }).Transaction;

function serialize(serializer: Ser, data: unknown): Buffer {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const buf = new (ByteBuffer as any)((ByteBuffer as any).DEFAULT_CAPACITY, (ByteBuffer as any).LITTLE_ENDIAN);
	serializer(buf, data);
	buf.flip();
	return Buffer.from(buf.toBuffer());
}

// Deterministic, valid Blurt public key derived via dblurt itself, so the
// PublicKey/Authority serializers accept it and round-trip.
const testPub = PrivateKey.fromSeed('morphit-cp324-claimed-account-test').createPublic().toString();
const auth = {
	weight_threshold: 1,
	account_auths: [] as Array<[string, number]>,
	key_auths: [[testPub, 1]] as Array<[string, number]>
};

const sharedAccountFields = {
	creator: 'morphit-relay',
	new_account_name: 'aliceblurt',
	owner: auth,
	active: auth,
	posting: auth,
	memo_key: testPub,
	json_metadata: ''
};

const tx = (ops: Array<[string, unknown]>) => ({
	ref_block_num: 1234,
	ref_block_prefix: 5678901,
	expiration: '2025-06-22T19:00:00',
	operations: ops,
	extensions: [] as unknown[]
});

const transferOp: [string, unknown] = [
	'transfer',
	{ from: 'morphit-relay', to: 'aliceblurt', amount: '1.000 BLURT', memo: '' }
];
const accountCreateOp: [string, unknown] = ['account_create', { fee: '100.000 BLURT', ...sharedAccountFields }];
const claimAccountOp: [string, unknown] = [
	'claim_account',
	{ creator: 'morphit-relay', fee: '100.000 BLURT', extensions: [] }
];
const createClaimedOp: [string, unknown] = ['create_claimed_account', { ...sharedAccountFields, extensions: [] }];

describe('claimedAccountSerializers', () => {
	it('stock dblurt cannot serialize claim_account or create_claimed_account (the bug)', () => {
		expect(() => serialize(stockTransaction, tx([claimAccountOp]))).toThrow(/serializer for operation: claim_account/);
		expect(() => serialize(stockTransaction, tx([createClaimedOp]))).toThrow(
			/serializer for operation: create_claimed_account/
		);
	});

	describe('after register', () => {
		let augmented: Ser;
		beforeAll(() => {
			registerClaimedAccountOperationSerializers();
			augmented = (Types as unknown as { Transaction: Ser }).Transaction;
		});

		it('is byte-identical to stock dblurt for existing ops (no regression)', () => {
			expect(serialize(augmented, tx([transferOp]))).toEqual(serialize(stockTransaction, tx([transferOp])));
			expect(serialize(augmented, tx([accountCreateOp]))).toEqual(
				serialize(stockTransaction, tx([accountCreateOp]))
			);
			// A multi-op tx (transfer + account_create) also matches.
			expect(serialize(augmented, tx([transferOp, accountCreateOp]))).toEqual(
				serialize(stockTransaction, tx([transferOp, accountCreateOp]))
			);
		});

		it('now serializes the two ACT ops without throwing', () => {
			expect(() => serialize(augmented, tx([claimAccountOp]))).not.toThrow();
			expect(() => serialize(augmented, tx([createClaimedOp]))).not.toThrow();
		});

		it('emits the correct operation ids (15 and 16)', () => {
			// The op serializer writes the op-id as the first varint; both ids
			// are < 128 so they encode as a single byte.
			expect(serialize(claimAccountSerializer, claimAccountOp[1])[0]).toBe(CLAIM_ACCOUNT_OP_ID);
			expect(serialize(createClaimedAccountSerializer, createClaimedOp[1])[0]).toBe(
				CREATE_CLAIMED_ACCOUNT_OP_ID
			);
		});

		it("create_claimed_account's fields match account_create's shared fields exactly", () => {
			// account_create op = [varint 5][fee asset][shared fields]
			// create_claimed   = [varint 16][shared fields][extensions=0x00]
			const accBytes = serialize(augmented, tx([accountCreateOp]));
			const ccaBytes = serialize(augmented, tx([createClaimedOp]));

			// Length of the fee asset, measured by serializing it alone.
			const feeLen = serialize((Types as unknown as { Asset: Ser }).Asset, '100.000 BLURT').length;

			// Operation bytes within the tx: after the 10-byte envelope
			// (ref_block_num 2 + ref_block_prefix 4 + expiration 4) and the
			// 1-byte operations-array count; the tx ends with a 1-byte
			// extensions count.
			const ENVELOPE_AND_OPCOUNT = 11;
			const accOp = accBytes.subarray(ENVELOPE_AND_OPCOUNT, accBytes.length - 1);
			const ccaOp = ccaBytes.subarray(ENVELOPE_AND_OPCOUNT, ccaBytes.length - 1);

			// Drop account_create's [op-id + fee asset] prefix and
			// create_claimed_account's [op-id] prefix + trailing extensions byte.
			const accShared = accOp.subarray(1 + feeLen);
			const ccaShared = ccaOp.subarray(1, ccaOp.length - 1);
			expect(ccaShared).toEqual(accShared);
		});
	});

	it('is installed at relay startup (client.ts calls the registrar at module load)', () => {
		// The unit tests above call register() themselves, so they would still
		// pass if the wiring were removed from the relay's runtime path. Guard
		// it: client.ts must import AND call the registrar at top level (not
		// inside a function/class), so every BlurtClient broadcast path has the
		// serializers installed before it can run.
		const src = readFileSync(resolve(import.meta.dirname, '../src/blurt/client.ts'), 'utf8');
		const stripped = src
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/[^\n]*/g, '');
		expect(stripped).toMatch(
			/import\s*\{\s*registerClaimedAccountOperationSerializers\s*\}\s*from\s*['"]\.\/claimedAccountSerializers\.ts['"]/
		);
		// Top-level call: appears at column 0 (not indented inside a block).
		expect(stripped).toMatch(/\nregisterClaimedAccountOperationSerializers\(\);/);
	});
});
