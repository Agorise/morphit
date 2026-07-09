/**
 * Morphit — low-level Blurt transaction signer.
 *
 * Uses @beblurt/dblurt's crypto + serialization primitives (PrivateKey
 * signing, Transaction shape, reference-block-id derivation) but
 * bypasses its HTTP transport. Instead, we:
 *
 *   1. Read the chain head (for ref_block / expiration) same-origin via the
 *      indexer proxy (broadcastTransport.fetchDynamicGlobalProperties)
 *   2. Build and sign a Transaction locally with dblurt's helpers
 *   3. Submit the signed tx same-origin through the indexer broadcast proxy
 *      (broadcastTransport.submitSignedTransaction → POST /v1/broadcast),
 *      with a direct-RPC fallback if the proxy is unreachable (cp344)
 *
 * The net effect: dblurt's well-tested crypto is used as a library, chain
 * access is relayed through the operator's own indexer (no cross-origin RPC,
 * no IP leak to third-party nodes), and the user's posting key never leaves
 * the browser.
 *
 * ADR-0007 corrected the package name (was `dblurt`; is `@beblurt/dblurt`)
 * and the underlying curve (was Ed25519 from libsodium; is secp256k1
 * from @noble/secp256k1, as the chain requires). Both were latent from
 * Phase 2 and would have failed on first real RPC contact. P2-12
 * tracks the integration-test gap that let this go undetected.
 */

import {
	PrivateKey,
	Client,
	cryptoUtils,
	type Transaction,
	type SignedTransaction,
	type Operation
} from '@beblurt/dblurt';
import { signDigestWithNoble } from './nobleSigner';
import { submitSignedTransaction, fetchDynamicGlobalProperties } from './broadcastTransport';
import { OP_IDS, SIGNER_BACKEND, type MorphitOpId } from '$net/config';
// Relative, NOT `$blurt/accountBinding`: in `tsconfig.smoke.json` the `$blurt/*`
// alias points at apps/indexer/src/blurt/*, so the same specifier means a
// different directory under the smoke runner than under web's Vite config.
import { resolveBroadcastAccount } from './accountBinding';
import type { LiveIdentity } from '$crypto/keygen';

/** Convert a Uint8Array (raw 32-byte secp256k1 scalar) into a dblurt
 *  PrivateKey. dblurt's PrivateKey constructor accepts a Uint8Array
 *  and treats it as the scalar — the same format keygen.ts produces.
 *  TypeScript types it as `Buffer` but at runtime any Uint8Array
 *  works (Buffer extends Uint8Array in Node; the `buffer` polyfill
 *  Vite ships for browser builds is the same shape).  Cast via
 *  unknown because the declared types don't have a structural
 *  subtype relationship. */
function rawToPrivateKey(raw: Uint8Array): PrivateKey {
	return new PrivateKey(raw as unknown as Buffer);
}

/** Sign a transaction with one or more PrivateKeys.
 *
 *  dblurt does NOT expose `Client.signTransaction` as a static
 *  method (despite older docs/code that assumed so).  The actual
 *  signing API is `client.broadcast.sign(tx, key)` on a dblurt
 *  Client INSTANCE.
 *
 *  Morphit's local `BlurtClient` wrapper (in `./client.ts`) is a
 *  separate class that uses our endpoint rotator for transport;
 *  it does NOT expose dblurt's broadcast helper.  Since
 *  `broadcast.sign` is PURE CRYPTO with no network round-trip
 *  (verified by unit-test against an unreachable endpoint), we
 *  construct a throwaway dblurt Client whose endpoints are never
 *  contacted.  The single instance is cached at module scope to
 *  avoid per-call allocation overhead.
 *
 *  Returns a non-mutating SignedTransaction. */
let _signingClient: Client | null = null;
function getSigningClient(): Client {
	if (_signingClient === null) {
		// Endpoint never contacted — broadcast.sign is local crypto.
		// We pass a syntactically-valid URL only because dblurt's
		// constructor validates the shape.
		_signingClient = new Client(['https://signing-only.invalid']);
	}
	return _signingClient;
}
function signTransactionWithKey(
	tx: Transaction,
	key: PrivateKey,
	rawScalar: Uint8Array
): SignedTransaction {
	if (SIGNER_BACKEND === 'noble') {
		// ADR-0046 opt-in path.  Reuse dblurt's serializer + chain-id binding to
		// compute the EXACT same digest the dblurt path would sign, then run the
		// ECDSA with @noble/secp256k1 instead of dblurt's elliptic-based signer.
		// The chain verifies by public-key recovery, so this is accepted as long
		// as the (canonical) signature recovers to the signing key — proven in
		// scripts/blurt-noble-signer-recovery-proof.ts and the tx-level
		// scripts/blurt-noble-tx-signature-proof.ts.  dblurt's signing client
		// is constructed with no chainId, so transactionDigest's default
		// (DEFAULT_CHAIN_ID = Blurt mainnet) matches the dblurt path's chain id.
		const digest = cryptoUtils.transactionDigest(tx);
		// rawScalar is the 32-byte secp256k1 private scalar the caller already
		// holds (the same bytes rawToPrivateKey wrapped).  We pass it through
		// rather than reading dblurt's private PrivateKey.key field.
		const sigHex = signDigestWithNoble(Uint8Array.from(digest), Uint8Array.from(rawScalar));
		// Non-mutating: clone and append, mirroring dblurt's signTransaction.
		const signatures = Array.isArray((tx as SignedTransaction).signatures)
			? [...(tx as SignedTransaction).signatures]
			: [];
		signatures.push(sigHex);
		return { ...tx, signatures } as SignedTransaction;
	}
	// Default path (unchanged): dblurt's well-tested elliptic-based signer.
	return getSigningClient().broadcast.sign(tx, key);
}

/** Phase F.5 audit fix (F-15) — canonical Blurt account name shape.
 *  Defense-in-depth: callers should validate upstream, but this
 *  guard at the broadcast boundary catches future regressions.
 *  Same regex as the chat-payload BLURT_ACCOUNT_RE. */
const BROADCAST_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** Phase F.5 audit fix (F-16) — canonical chain-asset string.
 *  BLURT is a 3-decimal asset.  The wallet's broadcast must be in
 *  exactly this shape or the chain rejects with confusing errors.
 *  Use this guard so callers see a clear "wrong format" message
 *  before the chain roundtrip. */
const BROADCAST_AMOUNT_RE = /^\d+\.\d{3}\s+BLURT$/;

/** VESTS asset string — 6-decimal, used by `withdraw_vesting` (power
 *  down). VESTS is the raw vesting-shares unit the chain stores; the
 *  user thinks in BP (Blurt Power) but the op amount is VESTS. Same
 *  6-decimal shape as `reward_vesting_balance` in claim_reward. */
const BROADCAST_VESTS_RE = /^\d+\.\d{6}\s+VESTS$/;

/** Fetch the chain head, return ref_block info for a transaction. */
async function getRefBlockInfo(): Promise<{
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
}> {
	// cp344: read the chain head SAME-ORIGIN (indexer proxy, direct-RPC
	// fallback) so building a broadcast no longer depends on a third-party
	// RPC node being browser-reachable — the same node a broadcast hits.
	const props = await fetchDynamicGlobalProperties();

	// Graphene-lineage chains (Steem, Hive, Blurt) derive ref_block_num
	// and ref_block_prefix from the head block id. dblurt provides a
	// helper, but since we're using our own client we compute directly:
	// last two bytes of block number + four bytes at offset 4 of the
	// block-id hex, little-endian.
	const blockNum = props.head_block_number;
	const blockId = props.head_block_id;
	const ref_block_num = blockNum & 0xffff;
	// block_id is a hex string; bytes 4..8 are ref_block_prefix (LE).
	// Phase F.5 audit fix (F-20) — parenthesize so >>> 0 applies
	// to the FINAL OR-result.  Pre-fix the precedence allowed
	// the intermediate combine to produce a negative int32 which
	// only got unsigned-converted at the last step; downstream
	// consumers (Graphene asset packers) tolerated this in
	// practice but the shape was correctness-fragile.
	const prefixHex = blockId.slice(8, 16);
	const ref_block_prefix =
		(parseInt(prefixHex.slice(0, 2), 16) |
			(parseInt(prefixHex.slice(2, 4), 16) << 8) |
			(parseInt(prefixHex.slice(4, 6), 16) << 16) |
			(parseInt(prefixHex.slice(6, 8), 16) << 24)) >>>
		0;

	// Transactions expire 60 seconds after head block time, standard for Blurt.
	const head = new Date(props.time + 'Z').getTime();
	const expiration = new Date(head + 60_000).toISOString().slice(0, -5); // drop ms + Z

	return { ref_block_num, ref_block_prefix, expiration };
}

// ─── Phase F.5 audit fix (F-18): split sign + broadcast ──────────
//
// Pre-fix, broadcastTransfer and broadcastOrderWithFee held the
// active-key scalar in scope for the entire network roundtrip
// (200-2000ms).  The fix is to split each operation into three
// phases:
//
//   1. prepare — async, fetches ref-block info, assembles the
//      unsigned Transaction.  No key needed.
//   2. sign — pure sync, ~10ms.  Active key only lives during
//      this call, inside the runWithActiveKey closure.  Upon
//      return, useActiveKey wipes the scalar.
//   3. broadcast — async, network only.  No key in scope.
//
// Caller pattern:
//
//   const tx = await prepareUnsignedTransfer(from, to, amount, memo);
//   const signed = await runWithActiveKey(pwd, async (activePriv) =>
//       signTransferWithKey(tx, activePriv)
//   );
//   // active-key scalar wiped here
//   const result = await broadcastSignedTransaction(signed);
//
// dblurt's Client.signTransaction is non-mutating: returns a
// deep-copy with the appended signature.  SignedTransaction
// holds only string signatures, no key references — so it's
// safe to carry past the wipe.

/** Phase F.5 audit fix (F-18) — assemble the unsigned transfer
 *  Transaction (async, no key needed). */
export async function prepareUnsignedTransfer(
	from: string,
	to: string,
	amount: string,
	memo: string
): Promise<Transaction> {
	if (!from) throw new Error('prepareUnsignedTransfer: missing from account');
	if (!to) throw new Error('prepareUnsignedTransfer: missing to account');
	if (!BROADCAST_ACCOUNT_RE.test(from)) {
		throw new Error('prepareUnsignedTransfer: from is not a valid account name');
	}
	if (!BROADCAST_ACCOUNT_RE.test(to)) {
		throw new Error('prepareUnsignedTransfer: to is not a valid account name');
	}
	if (!BROADCAST_AMOUNT_RE.test(amount)) {
		throw new Error('prepareUnsignedTransfer: amount must be "N.NNN BLURT" (3 decimal places)');
	}
	if (from === to) {
		throw new Error('prepareUnsignedTransfer: from === to (self-transfer)');
	}

	const { ref_block_num, ref_block_prefix, expiration } = await getRefBlockInfo();

	return {
		ref_block_num,
		ref_block_prefix,
		expiration,
		operations: [['transfer', { from, to, amount, memo }]],
		extensions: []
	};
}

/** Assemble the unsigned `transfer_to_vesting` (POWER UP) Transaction —
 *  async, no key needed (mirrors prepareUnsignedTransfer's F-18 split).
 *
 *  Power-up moves LIQUID BLURT into staked VESTS. Requires ACTIVE
 *  authority. Unlike a plain transfer, `from === to` is the NORMAL case
 *  (a user powers up their OWN balance), so self is ALLOWED here.
 *  `amount` is a 3-decimal BLURT string. Sign with `signTransferWithKey`
 *  (the active-key signer — reused, it signs any active-level tx) inside
 *  a runWithActiveKey closure, then `broadcastSignedTransaction`. */
export async function prepareUnsignedTransferToVesting(
	from: string,
	to: string,
	amount: string
): Promise<Transaction> {
	if (!from) throw new Error('prepareUnsignedTransferToVesting: missing from account');
	if (!to) throw new Error('prepareUnsignedTransferToVesting: missing to account');
	if (!BROADCAST_ACCOUNT_RE.test(from)) {
		throw new Error('prepareUnsignedTransferToVesting: from is not a valid account name');
	}
	if (!BROADCAST_ACCOUNT_RE.test(to)) {
		throw new Error('prepareUnsignedTransferToVesting: to is not a valid account name');
	}
	if (!BROADCAST_AMOUNT_RE.test(amount)) {
		throw new Error(
			'prepareUnsignedTransferToVesting: amount must be "N.NNN BLURT" (3 decimal places)'
		);
	}
	// NOTE: from === to is intentionally permitted — powering up your OWN
	// balance is the normal case (and the only one Morphit's UI offers).

	const { ref_block_num, ref_block_prefix, expiration } = await getRefBlockInfo();

	return {
		ref_block_num,
		ref_block_prefix,
		expiration,
		operations: [['transfer_to_vesting', { from, to, amount }]],
		extensions: []
	};
}

/** Assemble the unsigned `withdraw_vesting` (POWER DOWN) Transaction —
 *  async, no key needed. Requires ACTIVE authority.
 *
 *  Power-DOWN unstakes VESTS back to liquid BLURT over the chain's
 *  4-week / 13-weekly-payment schedule (the chain enforces the schedule;
 *  this op just STARTS it — the UI must say so honestly, never imply
 *  the funds arrive instantly). `vestingShares` is a 6-decimal VESTS
 *  string (NOT BLURT): the caller converts the user's BP figure via
 *  `balanceMath.blurtPowerToVests`, or — for "power down everything" —
 *  passes the account's EXACT on-chain `vesting_shares` so no dust is
 *  left behind by a round-trip conversion. `"0.000000 VESTS"` is a legal
 *  op (it CANCELS an in-progress power-down) and is permitted here; the
 *  UI decides whether to surface that. */
export async function prepareUnsignedWithdrawVesting(
	account: string,
	vestingShares: string
): Promise<Transaction> {
	if (!account) throw new Error('prepareUnsignedWithdrawVesting: missing account');
	if (!BROADCAST_ACCOUNT_RE.test(account)) {
		throw new Error('prepareUnsignedWithdrawVesting: account is not a valid account name');
	}
	if (!BROADCAST_VESTS_RE.test(vestingShares)) {
		throw new Error(
			'prepareUnsignedWithdrawVesting: vesting_shares must be "N.NNNNNN VESTS" (6 decimal places)'
		);
	}

	const { ref_block_num, ref_block_prefix, expiration } = await getRefBlockInfo();

	return {
		ref_block_num,
		ref_block_prefix,
		expiration,
		operations: [['withdraw_vesting', { account, vesting_shares: vestingShares }]],
		extensions: []
	};
}

/** Phase F.5 audit fix (F-18) — sign a transfer transaction
 *  with the active key.  Pure, sync, ~10ms.  Caller invokes from
 *  inside a runWithActiveKey closure so the key wipe happens
 *  immediately after this returns. */
export function signTransferWithKey(tx: Transaction, activePriv: Uint8Array): SignedTransaction {
	if (!(activePriv instanceof Uint8Array) || activePriv.length !== 32) {
		throw new Error('signTransferWithKey: active key missing or malformed.');
	}
	const activeKey = rawToPrivateKey(activePriv);
	return signTransactionWithKey(tx, activeKey, activePriv);
}

/** Phase F.5 audit fix (F-18) — assemble the unsigned order-with-
 *  fee Transaction (async, no key needed). */
export async function prepareUnsignedOrderWithFee(
	opId: MorphitOpId,
	orderPayload: unknown,
	blurtAccount: string,
	feeTransfers: ReadonlyArray<{ to: string; amount: string }>,
	feeMemo: string
): Promise<Transaction> {
	if (!blurtAccount) {
		throw new Error('prepareUnsignedOrderWithFee: no Blurt account registered.');
	}
	if (feeTransfers.length === 0) {
		throw new Error('prepareUnsignedOrderWithFee: at least one fee transfer is required.');
	}

	const { ref_block_num, ref_block_prefix, expiration } = await getRefBlockInfo();

	// cp407 — this order op is ACTIVE-level, not posting. The sibling `transfer`
	// (the listing fee) below needs active authority, and Blurt (Graphene)
	// rejects any tx that mixes posting-level and active-level ops
	// (`required_active.size() == 0` assertion). So the whole tx is active-level:
	// one op set, one active signature, chain-valid. The indexer accepts an
	// active-level ORDER op specifically (see verify.ts extractSigner) and still
	// finds the fee as a sibling transfer, so fee verification + atomicity are
	// unchanged. (Waived/BTC/XMR orders carry no transfer, so they stay
	// posting-level via the single-op broadcastCustomJson path.)
	//
	// cp408 — the fee is now paid as ONE OR TWO sibling transfers (the
	// federation revenue split, computed by `feeTransfersFor`): 90% to the
	// instance owner + 10% to the canonical treasury, or a single 100% transfer
	// when the recipient IS the canonical treasury. Every leg shares the same
	// `feeMemo` so the indexer can sum them; all are active-level in this one tx.
	const customOp: Operation = [
		'custom_json',
		{
			required_auths: [blurtAccount],
			required_posting_auths: [],
			id: opId,
			json: JSON.stringify(orderPayload)
		}
	];

	const transferOps: Operation[] = feeTransfers.map((t) => {
		if (!BROADCAST_AMOUNT_RE.test(t.amount)) {
			throw new Error(
				'prepareUnsignedOrderWithFee: fee amount must be "N.NNN BLURT" (3 decimal places)'
			);
		}
		if (t.to === blurtAccount) {
			throw new Error('prepareUnsignedOrderWithFee: fee transfer to self.');
		}
		return [
			'transfer',
			{
				from: blurtAccount,
				to: t.to,
				amount: t.amount,
				memo: feeMemo
			}
		];
	});

	return {
		ref_block_num,
		ref_block_prefix,
		expiration,
		operations: [customOp, ...transferOps],
		extensions: []
	};
}

/** Phase F.5 audit fix (F-18) — sign an order-with-fee
 *  transaction with both posting and active keys.  Pure, sync.
 *  Active key lifetime is the duration of this call. */
/** cp407 — sign the order-with-fee transaction. Both the order custom_json
 *  and the fee transfer are now ACTIVE-level (Blurt forbids mixing posting +
 *  active in one tx), so the tx takes exactly ONE active signature — adding a
 *  posting signature would be an irrelevant/extra sig the chain can reject.
 *  Pure, sync. Active-key lifetime is the duration of this call. */
export function signOrderWithFeeWithKey(
	tx: Transaction,
	activePriv: Uint8Array
): SignedTransaction {
	if (!(activePriv instanceof Uint8Array) || activePriv.length !== 32) {
		throw new Error('signOrderWithFeeWithKey: active key missing or malformed.');
	}
	const activeKey = rawToPrivateKey(activePriv);
	return signTransactionWithKey(tx, activeKey, activePriv);
}

/** Phase F.5 audit fix (F-18) — broadcast a pre-signed
 *  transaction.  No keys in scope; pure network roundtrip. */
export async function broadcastSignedTransaction(
	signed: SignedTransaction
): Promise<{ block_num: number; trx_id: string }> {
	// cp344: same-origin broadcast proxy (direct-RPC fallback). See broadcastTransport.ts.
	return submitSignedTransaction(signed);
}

// ─── Phase F.5 audit fix (F-18): split sign + broadcast ──────────
//
// Pre-fix, broadcastTransfer and broadcastOrderWithFee held the
// active-key scalar in scope for the entire network roundtrip
// (200-2000ms).  The fix is to split each operation into three
// phases:
//
//   1. prepare — async, fetches ref-block info, assembles the
//      unsigned Transaction.  No key needed.
//   2. sign — pure sync, ~10ms.  Active key only lives during
//      this call, inside the runWithActiveKey closure.  Upon
//      return, useActiveKey wipes the scalar.
//   3. broadcast — async, network only.  No key in scope.
//
// Caller pattern:
//
//   const tx = await prepareUnsignedTransfer(from, to, amount, memo);
//   const signed = await runWithActiveKey(pwd, async (activePriv) =>
//       signTransferWithKey(tx, activePriv)
//   );
//   // active-key scalar wiped here
//   const result = await broadcastSignedTransaction(signed);
//
// dblurt's Client.signTransaction is non-mutating: returns a
// deep-copy with the appended signature.  SignedTransaction
// holds only string signatures, no key references — so it's
// safe to carry past the wipe.

/**
 * Broadcast a `custom_json` op signed by the user's posting key.
 *
 * @param live          The session LiveIdentity — posting private key is read from here.
 * @param id            A Morphit op id (see OP_IDS in $net/config).
 * @param payload       The op body (will be JSON-serialized).
 * @param blurtAccount  The Blurt account name that signs the op. For
 *                      unregistered users, this will be null and the
 *                      function throws — the caller should fall back to
 *                      local-only behavior (e.g. settings page stores the
 *                      display name in localStorage and will broadcast
 *                      after account creation).
 */
export async function broadcastCustomJson(
	live: LiveIdentity,
	id: MorphitOpId,
	payload: unknown,
	blurtAccount: string
): Promise<{ block_num: number; trx_id: string }> {
	if (!blurtAccount) {
		throw new Error(
			'Cannot broadcast: no Blurt account registered yet. ' +
				'The display name was saved locally and will be broadcast ' +
				'once you register your account.'
		);
	}
	// F-15-style defense-in-depth: callers should validate account
	// name upstream (and SvelteKit's `account` route matcher does
	// for /chat/:peer paths), but this guard at the broadcast
	// boundary catches future regressions where a path forgets
	// validation.  Mirrors prepareUnsignedTransfer's check.  Without
	// this, a malformed account name fails at the chain
	// (`is_valid_account_name` rejects with a confusing error); with
	// it, the failure is local and the message is clear.
	if (!BROADCAST_ACCOUNT_RE.test(blurtAccount)) {
		throw new Error('broadcastCustomJson: blurtAccount is not a valid account name');
	}

	// The account we DECLARE must be one the key we SIGN with actually controls.
	// `blurtAccount` comes from an origin-wide localStorage value that any other
	// tab's sign-in can rewrite; the posting key is what the chain checks. So the
	// key decides, and the stored name is only a hint for disambiguation.
	// Anything else produces "Missing Posting Authority <someone else>" — see
	// accountBinding.ts.
	const signingAccount = await resolveBroadcastAccount(live, blurtAccount);

	const { ref_block_num, ref_block_prefix, expiration } = await getRefBlockInfo();

	const op: Operation = [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: [signingAccount],
			id,
			json: JSON.stringify(payload)
		}
	];

	const tx: Transaction = {
		ref_block_num,
		ref_block_prefix,
		expiration,
		operations: [op],
		extensions: []
	};

	// Sign using dblurt's primitive. This is a pure-JS operation; no
	// network, no key-exfiltration opportunity.
	const postingKey = rawToPrivateKey(live.posting.privateKey);
	const signed: SignedTransaction = signTransactionWithKey(tx, postingKey, live.posting.privateKey);

	// cp344: broadcast SAME-ORIGIN through the indexer proxy (direct-RPC
	// fallback) — no cross-origin RPC connection, no IP leak to third-party
	// nodes. See broadcastTransport.ts.
	const result = await submitSignedTransaction(signed);
	return result;
}

export const MORPHIT_OP_IDS = OP_IDS;

/**
 * Broadcast a `claim_reward_balance` op signed by the user's posting key,
 * sweeping the account's unclaimed author/curation rewards into its usable
 * (liquid BLURT + powered-up BP) balances. cp396.
 *
 * Same-origin via the indexer broadcast proxy (claim_reward_balance is on
 * its op whitelist), with the direct-RPC fallback inherited from
 * submitSignedTransaction. Posting authority only — the signer can claim
 * ONLY their own rewards, so this op can never move another account's funds.
 *
 * @param live          Session LiveIdentity — posting private key read from here.
 * @param blurtAccount  The account claiming (chain-enforced as the only payee).
 * @param rewardBlurt   Liquid reward as a Graphene asset string, e.g.
 *                      "1.234 BLURT" — exactly reward_blurt_balance (claim all).
 * @param rewardVests   Vesting reward as a VESTS asset string, e.g.
 *                      "1000.000000 VESTS" — exactly reward_vesting_balance.
 */
export async function broadcastClaimReward(
	live: LiveIdentity,
	blurtAccount: string,
	rewardBlurt: string,
	rewardVests: string
): Promise<{ block_num: number; trx_id: string }> {
	if (!blurtAccount) {
		throw new Error('Cannot claim rewards: no Blurt account registered.');
	}
	if (!BROADCAST_ACCOUNT_RE.test(blurtAccount)) {
		throw new Error('broadcastClaimReward: blurtAccount is not a valid account name');
	}

	const { ref_block_num, ref_block_prefix, expiration } = await getRefBlockInfo();

	const op: Operation = [
		'claim_reward_balance',
		{
			account: blurtAccount,
			reward_blurt: rewardBlurt,
			reward_vests: rewardVests
		}
	];

	const tx: Transaction = {
		ref_block_num,
		ref_block_prefix,
		expiration,
		operations: [op],
		extensions: []
	};

	// Pure-JS sign with the posting key; no network, no key-exfiltration path.
	const postingKey = rawToPrivateKey(live.posting.privateKey);
	const signed: SignedTransaction = signTransactionWithKey(tx, postingKey, live.posting.privateKey);

	const result = await submitSignedTransaction(signed);
	return result;
}
