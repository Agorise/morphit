/**
 * Morphit — withdraw_vesting (POWER DOWN) local signing.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  WHY THIS MODULE EXISTS
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  @beblurt/dblurt's operation serializer has NO entry for
 *  `withdraw_vesting` (Graphene op ID 4). dblurt registers
 *  `transfer`(2), `transfer_to_vesting`(3), `delegate_vesting_shares`(32)
 *  and many others — but not withdraw_vesting. So signing a power-down
 *  through dblurt's normal path (`broadcast.sign` → `transactionDigest`
 *  → its serializer) throws at RUNTIME:
 *
 *      No serializer for operation: withdraw_vesting
 *
 *  The TYPE accepts the op (svelte-check is green); the runtime does
 *  not. Left unhandled, a power-down would fail the instant the user
 *  entered their password and confirmed — a live money button that is
 *  broken for everyone. (The wallet-op-builders smoke's genuine
 *  round-trip test is what caught this.)
 *
 *  FIX: build the transaction digest BY HAND from dblurt's EXPORTED
 *  `Types` primitives (the same building blocks its own serializer uses)
 *  and sign it with the noble signer. This is byte-identical to what a
 *  complete dblurt would produce — pinned by the byte-identity guard in
 *  wallet-op-builders-smoke, which serializes a KNOWN op
 *  (`transfer_to_vesting`) both ways and asserts the digests match. No
 *  fork, no patch of dblurt's private serializer map.
 *
 *  The manual serializer intentionally ALSO knows `transfer_to_vesting`
 *  (op ID 3) — an op dblurt DOES serialize — purely so that guard can
 *  prove this path matches dblurt exactly. Production only ever calls it
 *  for withdraw_vesting (see the guard in `signWithdrawVestingWithKey`).
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

import ByteBuffer from 'bytebuffer';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2';
import {
	Types,
	DEFAULT_CHAIN_ID,
	type Transaction,
	type SignedTransaction
} from '@beblurt/dblurt';
import { signDigestWithNoble } from './nobleSigner';

/** dblurt's `Types` is typed loosely across the node_modules boundary;
 *  pin the exact primitive signatures we call so our own code stays
 *  type-safe. Each takes the shared bytebuffer instance. */
const T = Types as unknown as {
	UInt16: (buffer: ByteBuffer, value: number) => void;
	UInt32: (buffer: ByteBuffer, value: number) => void;
	Date: (buffer: ByteBuffer, value: string) => void;
	String: (buffer: ByteBuffer, value: string) => void;
	Asset: (buffer: ByteBuffer, value: string) => void;
};

/** Serialize one operation body into the buffer, mirroring dblurt's
 *  `OperationDataSerializer(id, [...])` byte layout exactly: it writes
 *  `writeVarint32(id)` (done by the caller) then each field via its
 *  Types primitive in order. */
type OpBodySerializer = (buffer: ByteBuffer, payload: Record<string, unknown>) => void;

/** Graphene operation IDs + field serializers for the ops we serialize
 *  by hand. `withdraw_vesting` is the one dblurt lacks and the reason
 *  this module exists; `transfer_to_vesting` is retained ONLY as the
 *  byte-identity oracle (dblurt can serialize it, so the smoke can prove
 *  this path matches). Both use dblurt's own `Types` primitives so the
 *  byte layout is identical to dblurt's. */
const MANUAL_OPS: Readonly<Record<string, { readonly id: number; readonly body: OpBodySerializer }>> =
	{
		// op ID 3 — dblurt HAS this; kept as the byte-identity oracle only.
		transfer_to_vesting: {
			id: 3,
			body: (buf, p) => {
				T.String(buf, p.from as string);
				T.String(buf, p.to as string);
				T.Asset(buf, p.amount as string);
			}
		},
		// op ID 4 — dblurt is MISSING this; the reason this module exists.
		withdraw_vesting: {
			id: 4,
			body: (buf, p) => {
				T.String(buf, p.account as string);
				T.Asset(buf, p.vesting_shares as string);
			}
		}
	};

/**
 * Compute the sha256 transaction digest by hand, for transactions whose
 * operation dblurt's serializer cannot handle. Byte-identical to
 * dblurt's `cryptoUtils.transactionDigest` for ops both know (guard-
 * pinned). Layout (Graphene, little-endian):
 *
 *   UInt16(ref_block_num) · UInt32(ref_block_prefix) · Date(expiration)
 *   · varint(operations.length) · [ varint(opId) · <fields> ]…
 *   · varint(extensions.length)
 *
 * then `sha256(DEFAULT_CHAIN_ID ‖ bytes)`.
 */
export function manualTransactionDigest(tx: Transaction): Uint8Array {
	const buffer = new ByteBuffer(ByteBuffer.DEFAULT_CAPACITY, ByteBuffer.LITTLE_ENDIAN);
	T.UInt16(buffer, tx.ref_block_num);
	T.UInt32(buffer, tx.ref_block_prefix);
	T.Date(buffer, tx.expiration as unknown as string);
	buffer.writeVarint32(tx.operations.length);
	for (const op of tx.operations) {
		const name = op[0] as string;
		const ser = MANUAL_OPS[name];
		if (!ser) {
			throw new Error(`manualTransactionDigest: no manual serializer for operation "${name}"`);
		}
		buffer.writeVarint32(ser.id);
		ser.body(buffer, op[1] as Record<string, unknown>);
	}
	buffer.writeVarint32(tx.extensions.length);
	buffer.flip();
	const txData = Buffer.from(buffer.toBuffer());
	return sha256(Buffer.concat([DEFAULT_CHAIN_ID as unknown as Buffer, txData]));
}

/**
 * Sign a `withdraw_vesting` (power-down) transaction with the raw
 * 32-byte active-key scalar. Pure + synchronous (~10ms); the caller
 * MUST invoke it from inside a `runWithActiveKey` closure so the key
 * scalar is wiped immediately after this returns.
 *
 * Uses the hand-rolled digest above + the noble signer, because dblurt's
 * signer cannot serialize this op. The signature verifies by public-key
 * recovery exactly like every other Blurt signature (proven in
 * wallet-op-builders-smoke).
 */
export function signWithdrawVestingWithKey(
	tx: Transaction,
	activePriv: Uint8Array
): SignedTransaction {
	if (!(activePriv instanceof Uint8Array) || activePriv.length !== 32) {
		throw new Error('signWithdrawVestingWithKey: active key missing or malformed.');
	}
	// Defence-in-depth: this signer bypasses dblurt's op dispatch, so it
	// must ONLY ever sign a withdraw_vesting-only transaction. Anything
	// else is a caller bug — refuse rather than silently sign something
	// the manual serializer wasn't built to validate.
	if (
		tx.operations.length === 0 ||
		!tx.operations.every((op) => op[0] === 'withdraw_vesting')
	) {
		throw new Error(
			'signWithdrawVestingWithKey: expected a withdraw_vesting-only transaction.'
		);
	}
	const digest = manualTransactionDigest(tx);
	const sigHex = signDigestWithNoble(digest, activePriv);
	const existing = Array.isArray((tx as SignedTransaction).signatures)
		? [...(tx as SignedTransaction).signatures]
		: [];
	existing.push(sigHex);
	return { ...tx, signatures: existing } as SignedTransaction;
}
