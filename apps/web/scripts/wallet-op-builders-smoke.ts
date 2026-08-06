/**
 * wallet-op-builders — cp424 (wallet security pass, foundation).
 *
 * The wallet's Power up (transfer_to_vesting), Power down
 * (withdraw_vesting), and Send (transfer) all sign with the ACTIVE key
 * and move money IRREVERSIBLY. This smoke pins the op-builder +
 * balance-math foundation those flows stand on:
 *
 *   1. Amount math — blurtPowerToVests round-trips with vestsToBlurtPower
 *      (a wrong power-DOWN conversion = wrong amount unstaked); the
 *      op-amount formatters emit EXACTLY the chain shapes ("N.NNN BLURT",
 *      "N.NNNNNN VESTS") and REFUSE a non-finite / negative number.
 *   2. Validation — the prepare* builders reject a malformed account or
 *      amount BEFORE the chain round-trip (the checks run before the
 *      network fetch, so this is exercisable offline); power-UP permits
 *      from === to (self power-up is normal), power-DOWN's VESTS shape is
 *      enforced.
 *   3. GENUINE round-trip signing — POWER UP (transfer_to_vesting) is
 *      signed with the real op-layer signer (signTransferWithKey) and
 *      the signature is verified to recover to the signing key; a
 *      DIFFERENT key is rejected (the signature actually binds the op).
 *   4. POWER DOWN (withdraw_vesting) — dblurt's serializer has NO entry
 *      for this op (op ID 4), so it's signed via the hand-rolled
 *      manualTransactionDigest (built from dblurt's exported Types) +
 *      signWithdrawVestingWithKey (noble). A BYTE-IDENTITY GUARD proves
 *      the manual digest matches dblurt's own digest for an op both know
 *      (transfer_to_vesting) — so the manual layout is provably correct
 *      and a dblurt format change is caught — then the withdraw_vesting
 *      signature is recovered against that manual digest (dblurt's
 *      verify path can't re-serialize this op either). Includes the
 *      cancel op (0.000000 VESTS) and the signer's defensive guards.
 *
 * The prepare* builders' happy path (which fetches ref_block over the
 * network) is integration-tested manually against a live endpoint, same
 * as prepareUnsignedTransfer; this smoke constructs a fixture tx for the
 * signing scenarios (mirrors chain-op-verify-smoke).
 */
import {
	PrivateKey,
	Signature,
	type AuthorityType,
	type Transaction,
	type SignedTransaction
} from '@beblurt/dblurt';
import { cryptoUtils } from '@beblurt/dblurt';
import { verifyTransactionSignatures } from '../src/lib/chat/chainOpVerifyCore.ts';
import {
	signTransferWithKey,
	prepareUnsignedTransferToVesting,
	prepareUnsignedWithdrawVesting
} from '../src/lib/blurt/sign.ts';
import {
	manualTransactionDigest,
	signWithdrawVestingWithKey
} from '../src/lib/blurt/withdrawVestingSign.ts';
import {
	blurtPowerToVests,
	vestsToBlurtPower,
	formatBlurtAmount,
	formatVestsAmount
} from '../src/lib/blurt/balanceMath.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failures++;
	}
}
async function throwsAsync(fn: () => Promise<unknown>): Promise<boolean> {
	try {
		await fn();
		return false;
	} catch {
		return true;
	}
}
function throwsSync(fn: () => unknown): boolean {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
}

async function run(): Promise<void> {
	console.log('wallet-op-builders smoke');

	// ─── 1. Amount math ────────────────────────────────────────────
	// Fixture pool: 1,000,000 BLURT staked across 500,000,000 VESTS →
	// 1 BP = 500 VESTS. (Numbers chosen so the ratio is exact.)
	const FUND = '1000000.000 BLURT';
	const TOTAL_VESTS = '500000000.000000 VESTS';
	check('blurtPowerToVests: 10 BP → 5000 VESTS at the fixture ratio', blurtPowerToVests(10, FUND, TOTAL_VESTS) === 5000);
	check(
		'round-trips with vestsToBlurtPower (5000 VESTS → 10 BP)',
		vestsToBlurtPower('5000.000000 VESTS', FUND, TOTAL_VESTS) === 10
	);
	check('blurtPowerToVests: zero fund (degenerate pool) → NaN', Number.isNaN(blurtPowerToVests(10, '0.000 BLURT', TOTAL_VESTS)));
	check('blurtPowerToVests: NaN bp → NaN', Number.isNaN(blurtPowerToVests(NaN, FUND, TOTAL_VESTS)));

	check('formatBlurtAmount: 1.5 → "1.500 BLURT" (exact 3 decimals)', formatBlurtAmount(1.5) === '1.500 BLURT');
	check('formatBlurtAmount: 0 → "0.000 BLURT"', formatBlurtAmount(0) === '0.000 BLURT');
	check('formatBlurtAmount: rounds to 3 decimals (1.23456 → "1.235 BLURT")', formatBlurtAmount(1.23456) === '1.235 BLURT');
	check('formatBlurtAmount: REFUSES NaN', throwsSync(() => formatBlurtAmount(NaN)));
	check('formatBlurtAmount: REFUSES negative', throwsSync(() => formatBlurtAmount(-1)));
	check('formatVestsAmount: 5000 → "5000.000000 VESTS" (exact 6 decimals)', formatVestsAmount(5000) === '5000.000000 VESTS');
	check('formatVestsAmount: REFUSES NaN', throwsSync(() => formatVestsAmount(NaN)));

	// ─── 2. Validation (runs before the network fetch) ─────────────
	check(
		'transfer_to_vesting: rejects a malformed from account',
		await throwsAsync(() => prepareUnsignedTransferToVesting('BAD!', 'alice', '1.000 BLURT'))
	);
	check(
		'transfer_to_vesting: rejects a malformed to account',
		await throwsAsync(() => prepareUnsignedTransferToVesting('alice', 'BAD!', '1.000 BLURT'))
	);
	check(
		'transfer_to_vesting: rejects a non-3-decimal amount',
		await throwsAsync(() => prepareUnsignedTransferToVesting('alice', 'alice', '1.0 BLURT'))
	);
	check(
		'transfer_to_vesting: rejects a VESTS amount (wrong asset)',
		await throwsAsync(() => prepareUnsignedTransferToVesting('alice', 'alice', '1.000000 VESTS'))
	);
	check(
		'withdraw_vesting: rejects a malformed account',
		await throwsAsync(() => prepareUnsignedWithdrawVesting('BAD!', '1.000000 VESTS'))
	);
	check(
		'withdraw_vesting: rejects a non-6-decimal VESTS amount',
		await throwsAsync(() => prepareUnsignedWithdrawVesting('alice', '1.000 VESTS'))
	);
	check(
		'withdraw_vesting: rejects a BLURT amount (wrong asset)',
		await throwsAsync(() => prepareUnsignedWithdrawVesting('alice', '1.000 BLURT'))
	);

	// ─── 3. Genuine round-trip signing ─────────────────────────────
	const priv = PrivateKey.fromSeed('morphit wallet op-builders smoke seed');
	const pub = priv.createPublic('BLT').toString();
	// The op-layer signer takes a raw 32-byte active-key scalar; extract
	// it from the dblurt PrivateKey (same bytes rawToPrivateKey wraps).
	const rawScalar = Uint8Array.from((priv as unknown as { key: Uint8Array }).key);
	check('extracted a 32-byte active-key scalar for signing', rawScalar.length === 32);

	const otherPriv = PrivateKey.fromSeed('a DIFFERENT unrelated key seed');
	const otherPub = otherPriv.createPublic('BLT').toString();

	const authFor = (key: string): AuthorityType => ({
		weight_threshold: 1,
		account_auths: [],
		key_auths: [[key, 1]]
	});
	const fixtureRef = { ref_block_num: 4321, ref_block_prefix: 987654, expiration: '2035-01-01T00:00:00' };

	const powerUpTx: Transaction = {
		...fixtureRef,
		operations: [['transfer_to_vesting', { from: 'alice', to: 'alice', amount: '1.500 BLURT' }]],
		extensions: []
	};
	const powerUpSigned = signTransferWithKey(powerUpTx, rawScalar);
	const powerUpOk = await verifyTransactionSignatures(powerUpSigned, authFor(pub));
	check(
		'transfer_to_vesting: signed with the active key → verifies (weightSum 1)',
		powerUpOk.ok === true && powerUpOk.weightSum === 1,
		JSON.stringify(powerUpOk)
	);
	const powerUpWrong = await verifyTransactionSignatures(powerUpSigned, authFor(otherPub));
	check(
		'transfer_to_vesting: does NOT verify against a different key',
		powerUpWrong.ok === false,
		JSON.stringify(powerUpWrong)
	);

	// ─── 4. withdraw_vesting (POWER DOWN) — hand-serialized path ────
	// dblurt's serializer has NO entry for withdraw_vesting (op ID 4), so
	// power-down signs via manualTransactionDigest (built from dblurt's
	// EXPORTED Types primitives) + the noble signer. Two things must hold:
	//   (a) BYTE-IDENTITY GUARD — the manual digest matches dblurt's own
	//       digest for an op BOTH can serialize (transfer_to_vesting). If a
	//       dblurt upgrade ever changes the byte format (or adds
	//       withdraw_vesting), this catches it.
	const oracleDblurt = Buffer.from(cryptoUtils.transactionDigest(powerUpTx)).toString('hex');
	const oracleManual = Buffer.from(manualTransactionDigest(powerUpTx)).toString('hex');
	check(
		'byte-identity: manual digest == dblurt digest for transfer_to_vesting',
		oracleDblurt === oracleManual,
		`dblurt=${oracleDblurt} manual=${oracleManual}`
	);

	//   (b) GENUINE round-trip — sign a withdraw_vesting tx with the real
	//       power-down signer and verify the signature recovers to the key.
	//       verifyTransactionSignatures itself re-serializes via dblurt (so
	//       it can't handle this op), so recovery is done directly against
	//       the manual digest — which the guard above just proved correct.
	const recoverSigner = (signed: SignedTransaction, tx: Transaction): string | null => {
		try {
			const digest = Buffer.from(manualTransactionDigest(tx));
			return Signature.fromString(signed.signatures[0]!).recover(digest).toString();
		} catch {
			return null;
		}
	};

	const powerDownTx: Transaction = {
		...fixtureRef,
		operations: [['withdraw_vesting', { account: 'alice', vesting_shares: '5000.000000 VESTS' }]],
		extensions: []
	};
	const powerDownSigned = signWithdrawVestingWithKey(powerDownTx, rawScalar);
	const powerDownSigner = recoverSigner(powerDownSigned, powerDownTx);
	check(
		'withdraw_vesting: signature recovers to the signing active key',
		powerDownSigner === pub,
		`recovered ${powerDownSigner}`
	);
	check(
		'withdraw_vesting: does NOT recover to a different key',
		powerDownSigner !== null && powerDownSigner !== otherPub
	);
	// "power down everything" cancel op (0.000000 VESTS) still signs + recovers.
	const cancelTx: Transaction = {
		...fixtureRef,
		operations: [['withdraw_vesting', { account: 'alice', vesting_shares: '0.000000 VESTS' }]],
		extensions: []
	};
	check(
		'withdraw_vesting: cancel (0.000000 VESTS) signs + recovers to the key',
		recoverSigner(signWithdrawVestingWithKey(cancelTx, rawScalar), cancelTx) === pub
	);

	// Defence: the power-down signer refuses a malformed scalar AND any tx
	// that isn't withdraw_vesting-only (it bypasses dblurt's op dispatch).
	check(
		'signWithdrawVestingWithKey: rejects a non-32-byte scalar',
		throwsSync(() => signWithdrawVestingWithKey(powerDownTx, new Uint8Array(16)))
	);
	check(
		'signWithdrawVestingWithKey: refuses a non-withdraw_vesting tx',
		throwsSync(() => signWithdrawVestingWithKey(powerUpTx, rawScalar))
	);
	check(
		'manualTransactionDigest: throws on an op it has no serializer for',
		throwsSync(() =>
			manualTransactionDigest({
				...fixtureRef,
				operations: [['vote', { voter: 'a', author: 'b', permlink: 'c', weight: 1 }]],
				extensions: []
			} as Transaction)
		)
	);

	// Signing must reject a malformed raw scalar (defence at the signer).
	check(
		'signTransferWithKey: rejects a non-32-byte scalar',
		throwsSync(() => signTransferWithKey(powerUpTx, new Uint8Array(16)))
	);

	const scenarios = 28;
	console.log(`\n${'─'.repeat(56)}`);
	if (failures === 0) {
		console.log(`✓ all ${scenarios} wallet-op-builders scenarios passed`);
		process.exit(0);
	} else {
		console.log(`✗ ${failures}/${scenarios} wallet-op-builders scenarios failed`);
		process.exit(1);
	}
}

void run();
