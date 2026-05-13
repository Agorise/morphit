/**
 * Morphit — active-key unlock helper.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  ELI5 — what is "active key"?  (NOT YubiKey-related!)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *  The naming collision with YubiKey unlock is unfortunate — both
 *  things use the word "active" but mean different things.  Here,
 *  "active" refers to one of Blurt's four CHAIN-LEVEL ROLE KEYS:
 *
 *    owner   — highest authority, never used in normal Morphit ops.
 *    active  — second highest, can move BLURT funds.  Used here.
 *    posting — third, used CONSTANTLY for chat/orders/comments.
 *    memo    — encrypts memos in private transfers.
 *
 *  See keystore.ts's `useActiveKey` doc-comment for the full role-key
 *  tier explainer.  Bottom line: Morphit avoids the active key in
 *  normal operation.  The legitimate triggers in current code:
 *
 *    - Paying a BLURT transfer fee for a trade (post page).
 *    - Bidding on a Featured-listing slot.
 *    - Paying a stranger-fee escrow.
 *    - First-time account signup (when we wire that up).
 *
 *  All of these prompt the user for their password, run for ~10ms,
 *  and wipe.  No long-lived active-key state.  This file is the thin
 *  helper that wraps the common pattern.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Wraps the common pattern found across the post page,
 * feature-bid form, and stranger-fee modal:
 *
 *   1. Identity must be unlocked (envelope on the store).
 *   2. Password must be non-empty.
 *   3. `useActiveKey(envelope, password, callback)` runs with
 *      the caller's broadcast closure.
 *   4. Errors get classified into a small discriminated union
 *      so the caller can show the right message without
 *      string-matching on `Error.message`.
 *
 * What's intentionally NOT in this helper:
 *
 *   - Password clearing. The caller holds the password in a
 *     let binding we can't touch; the contract is that the
 *     caller clears on BOTH the ok and the non-ok branch.
 *   - UI. Each call site has distinct layout constraints
 *     (post page uses a full phase screen, feature-bid form
 *     and stranger-fee modal inline the input). The shared
 *     behavior is the logic, not the presentation.
 *   - Minimum password length enforcement. Post page requires
 *     8, others any non-empty. The caller validates before
 *     calling.
 *   - Nuanced broadcast-error classification. This helper
 *     lumps every non-crypto error into `broadcast`. Call
 *     sites that need to distinguish (e.g. "insufficient
 *     funds" vs "locked account" vs generic chain reject)
 *     should do their own try/catch — the post page /order
 *     path is the canonical example and does NOT use this
 *     helper for that reason.
 *
 * Usage:
 *
 *   const r = await runWithActiveKey(password, async (activePriv) => {
 *     return broadcastFoo(liveIdentity, activePriv, input);
 *   });
 *   password = ''; // ALWAYS, regardless of outcome
 *   if (r.ok) {
 *     // success, r.value is whatever the callback returned
 *   } else {
 *     // r.kind tells the caller which translated error message to show
 *   }
 */

import { get } from 'svelte/store';
import { useActiveKey, KeystoreError } from '$crypto/keystore';
import { identity } from '$stores/identity';

/** Successful outcome — callback's return value passes through. */
export interface ActiveKeyOk<T> {
	readonly ok: true;
	readonly value: T;
}

/** Classified failure. `kind` drives the caller's message
 *  selection; `cause` is the underlying error (if any) for
 *  logging. Never exposed to the user directly — specific
 *  messages from the chain RPC layer may contain internals
 *  unsuitable for end users. */
export type ActiveKeyErrKind =
	/** Caller didn't validate — password was empty / missing. */
	| 'password_empty'
	/** Identity store is not in the 'unlocked' state. This is
	 *  defensive; UI should gate on $isUnlocked before calling,
	 *  but a lock race between gate and call is possible. */
	| 'locked'
	/** `useActiveKey` threw what looks like a password/decrypt
	 *  error. We classify heuristically (there's no typed error
	 *  the keystore throws today) and err on the side of
	 *  treating anything with 'password' or 'decrypt' in the
	 *  message as this — better UX than a generic error. */
	| 'bad_password'
	/** P5-5 audit fix: M6 pubkey mismatch — the envelope decrypted
	 *  to a different identity than the live session. This is the
	 *  cross-tab envelope-replacement attack signature. The UI
	 *  should surface a security-flavored message and prompt the
	 *  user to sign out and back in, NOT the generic "wrong
	 *  password" message. */
	| 'identity_mismatch'
	/** The callback itself threw. Network error, chain reject,
	 *  application-layer validation failure from the signer.
	 *  The caller usually wants to show the underlying message,
	 *  so we expose it via `cause.message`. */
	| 'broadcast';

export interface ActiveKeyErr {
	readonly ok: false;
	readonly kind: ActiveKeyErrKind;
	readonly cause?: unknown;
}

export type ActiveKeyResult<T> = ActiveKeyOk<T> | ActiveKeyErr;

/**
 * Run `callback` with the active-key scalar JIT-derived from
 * the user's password. Returns a discriminated union result
 * so the caller doesn't have to try/catch + string-match.
 *
 * The active-key scalar is wiped by `useActiveKey` before
 * this function returns, regardless of outcome. The caller's
 * password string is NOT wiped (it's a let in the caller's
 * scope) — the caller is responsible for clearing it.
 */
export async function runWithActiveKey<T>(
	password: string,
	callback: (activePriv: Uint8Array) => Promise<T>
): Promise<ActiveKeyResult<T>> {
	if (password.length === 0) {
		return { ok: false, kind: 'password_empty' };
	}

	const state = get(identity);
	if (state.state !== 'unlocked') {
		return { ok: false, kind: 'locked' };
	}

	try {
		// M6: pass the live posting pubkey so useActiveKey can
		// verify that the decrypted envelope is the SAME identity
		// as the running session.  Defends against cross-tab
		// envelope swap attacks (audit M6).
		const value = await useActiveKey(
			state.envelope,
			password,
			callback,
			state.live.posting.publicKey
		);
		return { ok: true, value };
	} catch (err) {
		// Audit 2026-05 finding 1-4 fix: typed dispatch on
		// KeystoreError.kind, not string matching.  String
		// matching on Error.message was fragile to wording
		// changes and misclassified envelope_corrupt as
		// bad_password (user gets "wrong password, retry"
		// when actually the envelope is corrupt and retry
		// won't help).
		if (err instanceof KeystoreError) {
			switch (err.kind) {
				case 'identity_mismatch':
					return { ok: false, kind: 'identity_mismatch', cause: err };
				case 'bad_password':
					return { ok: false, kind: 'bad_password', cause: err };
				case 'envelope_corrupt':
				case 'no_passphrase_wrap':
				case 'unsupported':
					// All three are non-retryable structural problems.
					// Surface as broadcast (generic) so the caller
					// shows the underlying message; UI can decide
					// whether to suggest re-import.
					return { ok: false, kind: 'broadcast', cause: err };
			}
		}
		// Non-KeystoreError: callback threw (network, chain
		// reject, application validation).
		return { ok: false, kind: 'broadcast', cause: err };
	}
}
