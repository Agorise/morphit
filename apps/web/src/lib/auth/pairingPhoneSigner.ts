/**
 * Phone-side pairing signer (ADR-0022).
 *
 * Wires the user's posting key (in-memory, post-unlock) to the
 * `BundleSigner` contract that the pure pairing crypto module
 * expects.
 *
 * Flow:
 *   1. Read the LiveIdentity from $stores/identity.  This
 *      requires the user has already unlocked their keystore;
 *      the scanner UI gates on `isUnlocked` before calling us.
 *   2. Read the user's Blurt account name from local storage
 *      (set at registration / import time).
 *   3. Derive the chat-identity pubkey from the posting priv
 *      via the same BLAKE2b-keyed derivation chat uses.
 *   4. Build a `BundleSigner` closure that hashes the canonical
 *      bundle bytes with the protocol's domain-separated prefix
 *      and signs with the posting private key via dblurt's
 *      secp256k1 primitive.
 *
 * Domain separation: the digest prefix is
 * `morphit-pairing-v1\n` (see SIGNING_DOMAIN_PREFIX in
 * desktopPairing.ts).  A captured pairing signature cannot be
 * replayed as a chain-transaction signature, and vice versa.
 *
 * Multisig limitation: this signer signs ONCE with the user's
 * posting key.  Accounts whose posting authority requires
 * multiple signatures cannot pair with this version — the
 * desktop verifier fails to clear weight_threshold with one
 * signature.  Multisig users fall back to seed-phrase import.
 *
 * YubiKey-backed posting keys: the LiveIdentity holds the
 * decrypted posting privateKey in memory after unlock
 * (regardless of whether the keystore was passphrase- or
 * YubiKey-protected at rest).  This signer works for both
 * keystore modes — the YubiKey ceremony happens during the
 * unlock flow before the user reaches the confirmation card.
 */

import { get } from 'svelte/store';
import { PrivateKey, cryptoUtils } from '@beblurt/dblurt';

import { liveIdentity } from '$lib/stores/identity';
import { getUserBlurtAccount } from '$lib/blurt/ops/profile';
import { deriveChatIdentity, encodeChatPub } from '$lib/chat/crypto';
import { computeBundleSigningDigest, type BundleSigner } from './desktopPairing';

export class PairingSignerError extends Error {
	constructor(
		public readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'PairingSignerError';
	}
}

/** Build a BundleSigner backed by the unlocked posting key.
 *  Returns the signer plus the account/chat-pubkey context the
 *  scanner UI needs to fill in the bundle's account fields.
 *
 *  Throws PairingSignerError with a code if the user isn't in
 *  the right state (locked, no account name set), or if the
 *  account's posting authority requires multiple signatures
 *  (multisig — single-sig protocol limitation; user must fall
 *  back to seed-phrase import).  The scanner UI surfaces these
 *  as 'failed' with appropriate copy.
 *
 *  Multisig detection rationale: the desktop verifier requires
 *  a single recovered key to clear `weight_threshold` alone.
 *  If the user's posting authority has no single key with
 *  enough weight, signing produces a bundle the desktop will
 *  reject with a confusing generic "couldn't verify the
 *  sign-in" error.  Detecting this on the phone side BEFORE
 *  signing lets us show the user a specific, actionable
 *  message ("Your account uses multi-key posting authority…").
 *  Costs one chain RPC per pairing attempt — acceptable for
 *  the UX win. */
export async function getPostingKeyForPairing(): Promise<{
	readonly signer: BundleSigner;
	readonly account: string;
	readonly chatPubkey: string;
}> {
	const live = get(liveIdentity);
	if (live === null) {
		throw new PairingSignerError(
			'not_unlocked',
			'Posting key not in memory. Unlock the keystore first.'
		);
	}
	const account = getUserBlurtAccount();
	if (account === null || account.length === 0) {
		throw new PairingSignerError('no_account_name', 'No Blurt account name on file.');
	}

	// Multisig pre-check.  Derive the user's posting pubkey in
	// chain string format (e.g. "BLT…") and look it up in the
	// account's on-chain posting.key_auths.  If no single key
	// (this user's, or any other) has weight clearing
	// weight_threshold alone, the protocol's single-signature
	// design can't satisfy this account — fail fast with a
	// specific error rather than letting the user reach a
	// confusing desktop-side rejection.
	let userPostingPubkeyStr: string;
	try {
		// privateKey is already a Uint8Array; dblurt's PrivateKey
		// constructor accepts that at runtime even though its TS
		// types say Buffer.  Same pattern as $lib/blurt/sign.ts —
		// avoids importing the Node `buffer` module into the
		// browser bundle (Vite can't resolve it).
		const privKey = new PrivateKey(live.posting.privateKey as unknown as Buffer);
		userPostingPubkeyStr = privKey.createPublic().toString();
	} catch (err) {
		throw new PairingSignerError(
			'sign_failed',
			`Failed to derive posting pubkey from in-memory key: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	try {
		// Lazy-import to avoid pulling the rotator into
		// environments that don't need it.
		const { getRotator } = await import('$lib/net/endpoints');
		const rotator = getRotator();
		const accounts = await rotator.call<unknown[]>('condenser_api.get_accounts', [[account]]);
		if (!Array.isArray(accounts) || accounts.length === 0) {
			throw new PairingSignerError(
				'account_not_found',
				`Account @${account} not found on chain. Verify your account name in Settings.`
			);
		}
		const acct = accounts[0] as Record<string, unknown>;
		const posting = acct.posting as
			| {
					weight_threshold: number;
					key_auths: Array<[string, number]>;
			  }
			| undefined;
		if (
			posting === undefined ||
			!Array.isArray(posting.key_auths) ||
			typeof posting.weight_threshold !== 'number'
		) {
			throw new PairingSignerError(
				'account_not_found',
				`Account @${account} returned an unexpected shape from the chain.`
			);
		}

		// Find this user's posting key in key_auths.
		const userEntry = posting.key_auths.find(
			([k]) => typeof k === 'string' && k === userPostingPubkeyStr
		);
		if (userEntry === undefined) {
			// User holds a posting key, but it's not the one
			// authorized on this account.  Either they imported
			// the wrong seed, or the account's posting authority
			// was rotated since they imported.  Treat as
			// unsupported here — they need to re-import.
			throw new PairingSignerError(
				'posting_key_not_authorized',
				`Your posting key isn't currently authorized for @${account}. The account's posting authority may have been rotated; re-import your seed or contact the account holder.`
			);
		}
		const [, userWeight] = userEntry;
		if (typeof userWeight !== 'number' || userWeight < posting.weight_threshold) {
			// Single signature won't clear threshold — multisig.
			throw new PairingSignerError(
				'multisig_unsupported',
				`@${account} uses multi-key posting authority (this version of QR sign-in only supports single-key accounts). Use seed-phrase import instead.`
			);
		}
		// Single-key with adequate weight — proceed.
	} catch (err) {
		// Re-throw structured errors as-is; treat anything else
		// as a chain-RPC failure.  We deliberately fail-fast on
		// RPC errors rather than letting the user sign a bundle
		// the desktop will reject — the user's experience of
		// "QR didn't work" is the same either way, and failing
		// here lets us show a specific message.
		if (err instanceof PairingSignerError) throw err;
		throw new PairingSignerError(
			'chain_unreachable',
			`Couldn't verify your account's posting authority: ${err instanceof Error ? err.message : String(err)}. Try again in a moment.`
		);
	}

	// Derive chat-identity pubkey.  Desktop uses this to
	// address chat to the paired session without an indexer
	// round-trip.  Wipe the priv half immediately — we only
	// need the pub.
	const chat = await deriveChatIdentity(live.posting.privateKey, account);
	const chatPubkey = encodeChatPub(chat.pub);
	chat.priv.fill(0);

	// Build the signer closure.  Captures live.posting.privateKey
	// by reference; the buffer is owned by the LiveIdentity
	// store and wiped on lock.
	const signer: BundleSigner = async (canonicalBytes) => {
		const digest = await computeBundleSigningDigest(canonicalBytes);
		// dblurt expects Buffer in its TS types but accepts any
		// Uint8Array at runtime.  Same browser-bundle-friendly
		// cast pattern as $lib/blurt/sign.ts.
		const digestBuf = digest as unknown as Buffer;

		const privKey = new PrivateKey(live.posting.privateKey as unknown as Buffer);

		let signature;
		try {
			signature = privKey.sign(digestBuf);
		} catch (err) {
			throw new PairingSignerError(
				'sign_failed',
				`secp256k1 sign failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		// dblurt produces a canonical signature internally
		// (retries until the s-value is in the lower half).
		// Defensive double-check; chain consensus rejects
		// non-canonical, and our verifier uses
		// Signature.fromBuffer which expects canonical form.
		if (!cryptoUtils.isCanonicalSignature(signature.data)) {
			throw new PairingSignerError(
				'non_canonical_signature',
				'Signing produced a non-canonical signature; retry pairing.'
			);
		}

		// Wire format: 1-byte (recovery + 31) || 32-byte r ||
		// 32-byte s = 65 bytes total.  This is what
		// Signature.fromBuffer accepts on the desktop side.
		const out = new Uint8Array(65);
		out[0] = signature.recovery + 31;
		out.set(signature.data, 1);
		return out;
	};

	return { signer, account, chatPubkey };
}
