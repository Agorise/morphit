/**
 * Morphit — desktop-side pairing client (ADR-0022).
 *
 * Glues the pure crypto module (`./desktopPairing.ts`) to the
 * browser surface: navigation, EventSource for SSE, fetch for
 * the chain pubkey lookup that backs signature verification.
 *
 * The component layer (`LoginQrInitiator.svelte`) drives the
 * lifecycle (mount → start session → on bundle → navigate to
 * home).  This module owns the wiring around it.
 */

import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$lib/net/config';

import {
	buildQrPayload,
	generateDesktopEphemeralKeys,
	verifyDeliveryPayload,
	type BundleVerifyResult,
	type DeliveryPayload,
	type PairingQrPayload,
	type SignatureVerifier
} from './desktopPairing';

/** State machine for a single pairing session. */
export type PairingState =
	| { kind: 'starting' }
	| {
			kind: 'awaiting_phone';
			qr: PairingQrPayload;
			compactWire: string;
			expSeconds: number;
	  }
	| { kind: 'received'; account: string; chatPubkey: string }
	| { kind: 'expired' }
	| { kind: 'rejected'; reason: string }
	| { kind: 'cancelled' };

/** Instantiate a fresh pairing session.  Generates ephemeral
 *  keys, builds the QR, opens the SSE wait, and resolves with
 *  the validated envelope on success or rejects on failure /
 *  expiry.  Caller manages cancellation via the AbortSignal. */
export async function startPairingSession(args: {
	readonly origin: string;
	readonly relayBase?: string;
	readonly nowSeconds: number;
	readonly onState: (state: PairingState) => void;
	readonly verifier?: SignatureVerifier; // defaults to chain-backed
	readonly signal?: AbortSignal;
}): Promise<void> {
	args.onState({ kind: 'starting' });

	const desktopKeys = await generateDesktopEphemeralKeys();
	const relayBase = args.relayBase ?? resolveOrigin(MORPHIT_INDEXER_ORIGIN);
	const { payload, compactWire } = await buildQrPayload({
		epk_pub: desktopKeys.epk_pub,
		origin: args.origin,
		relay: relayBase,
		nowSeconds: args.nowSeconds
	});

	args.onState({
		kind: 'awaiting_phone',
		qr: payload,
		compactWire,
		expSeconds: payload.exp
	});

	const verifier = args.verifier ?? defaultVerifier;

	// Open SSE.  If the user navigates away, the AbortSignal
	// closes the connection and we exit cleanly.
	const sseUrl = new URL(`/v1/login-pairing/${encodeURIComponent(payload.pid)}/wait`, relayBase);
	const es = new EventSource(sseUrl.toString());
	const cleanup = (): void => {
		try {
			es.close();
		} catch {
			// best-effort
		}
	};

	const onAbort = (): void => {
		cleanup();
		args.onState({ kind: 'cancelled' });
	};
	args.signal?.addEventListener('abort', onAbort, { once: true });

	es.addEventListener('expired', () => {
		cleanup();
		args.onState({ kind: 'expired' });
	});

	es.addEventListener('bundle', async (ev: MessageEvent) => {
		cleanup();
		try {
			const delivery = JSON.parse(ev.data) as DeliveryPayload;
			const result: BundleVerifyResult = await verifyDeliveryPayload({
				delivery,
				desktopEpkPriv: desktopKeys.epk_priv,
				desktopEpkPub: desktopKeys.epk_pub,
				desktopOrigin: args.origin,
				expectedPid: payload.pid,
				nowSeconds: Math.floor(Date.now() / 1000),
				verifier
			});
			if (result.kind === 'reject') {
				// Generic message — never leak the specific gate
				// that failed, that's just a hint for the
				// attacker to try harder.  Detailed reason in
				// console for debug.
				if (typeof console !== 'undefined') {
					console.warn('pairing: bundle rejected', result.reason);
				}
				args.onState({ kind: 'rejected', reason: result.reason.kind });
				return;
			}
			args.onState({
				kind: 'received',
				account: result.envelope.bundle.account,
				chatPubkey: result.envelope.bundle.account_chat_pubkey
			});
		} catch (err) {
			if (typeof console !== 'undefined') {
				console.warn('pairing: bundle parse/verify error', err);
			}
			args.onState({ kind: 'rejected', reason: 'parse_error' });
		}
	});

	es.addEventListener('error', () => {
		// EventSource auto-reconnects by default which we don't
		// want.  If the connection errors before we receive an
		// event, signal expired.
		if (es.readyState === EventSource.CLOSED) {
			args.onState({ kind: 'expired' });
		}
	});
}

/** Default chain-backed verifier.  Looks up `account`'s posting
 *  authority via the existing chain rotator, recovers the
 *  signing pubkey from the signature, and checks that the
 *  recovered pubkey appears in `posting.key_auths` with weight
 *  sufficient to clear `weight_threshold`.
 *
 *  Multisig is supported: if `key_auths` has multiple keys with
 *  weights summing to clear threshold, ANY single key with
 *  sufficient weight verifies.  (Bundles are signed by ONE
 *  key on the phone — the user's posting key — so for the
 *  common single-sig case this just checks "did THE posting
 *  key sign this".)
 *
 *  Domain separation: the message digest the phone signs is
 *  `SHA-256(SIGNING_DOMAIN_PREFIX || canonical_bundle_bytes)`,
 *  not the raw canonical bundle bytes nor the chain's
 *  transaction-signing format.  That way a captured pairing
 *  signature can NEVER be replayed as a chain-transaction
 *  signature, and vice versa.
 *
 *  Failure modes (all return false, never throw — caller treats
 *  any false as `signature_invalid`):
 *    - Account doesn't exist on chain
 *    - Account has no posting authority (shouldn't happen on
 *      Blurt; defensive)
 *    - Signature is malformed
 *    - Recovery succeeds but recovered pubkey isn't in posting
 *      key_auths
 *    - Recovered pubkey is in key_auths but its weight is
 *      below threshold
 *    - Chain RPC errors (treated as verification failure;
 *      operator who can't reach the chain can't sign people in,
 *      which is the conservative posture)
 */
const defaultVerifier: SignatureVerifier = async (account, canonicalBytes, signatureBytes) => {
	try {
		// Lazy-load these at call time — keeps the pairing client
		// importable in environments (smoke tests, server-side
		// rendering) where the chain rotator might not be wired.
		const { fetchAccountKeys } = await import('$blurt/accountKeys');
		const { resolveOrigin, MORPHIT_INDEXER_ORIGIN } = await import('$net/config');
		const { Signature } = await import('@beblurt/dblurt');
		const { computeBundleSigningDigest } = await import('./desktopPairing');
		const { Buffer } = await import('buffer');

		// Fetch the account's PUBLIC posting authority through the SAME-ORIGIN
		// indexer instead of a direct RPC call (privacy #1: third-party RPC
		// nodes never see the user's IP or which account is pairing). The keys
		// are public and the signature recovery below stays client-side, so a
		// malicious operator cannot forge a valid pairing by serving fake keys —
		// the worst it could do is make a legitimate pairing fail, a denial it
		// already has by virtue of serving the app itself.
		const keys = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account);
		if (!keys) {
			return false;
		}
		const posting = keys.posting;
		if (!Array.isArray(posting.key_auths) || typeof posting.weight_threshold !== 'number') {
			return false;
		}

		// Compute the message digest using the protocol's
		// domain-separated prefix.  Phone signs the same digest;
		// if signature recovers a key that's in posting and has
		// adequate weight, signature is valid.
		const digest = await computeBundleSigningDigest(canonicalBytes);
		const digestBuf = Buffer.from(digest);

		let signature: Awaited<ReturnType<typeof Signature.fromBuffer>>;
		try {
			signature = Signature.fromBuffer(Buffer.from(signatureBytes));
		} catch {
			return false;
		}

		let recoveredPubkeyStr: string;
		try {
			const recovered = signature.recover(digestBuf);
			recoveredPubkeyStr = recovered.toString();
		} catch {
			return false;
		}

		// Find the recovered pubkey in posting.key_auths and
		// verify its weight clears the threshold.
		for (const [pubkeyStr, weight] of posting.key_auths) {
			if (
				typeof pubkeyStr === 'string' &&
				pubkeyStr === recoveredPubkeyStr &&
				typeof weight === 'number' &&
				weight >= posting.weight_threshold
			) {
				return true;
			}
		}
		// Multisig case: if no single key carries threshold weight,
		// the bundle would need multiple signatures.  Our protocol
		// signs ONE bundle once, so multi-key-required accounts
		// can't pair with this version.  Honest limitation:
		// document, don't pretend to support.
		return false;
	} catch {
		// Any unexpected error → fail closed.
		return false;
	}
};
