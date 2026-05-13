/**
 * Morphit — two-step signup client.
 *
 * Wraps the /v1/account/invite + /v1/account/create protocol so
 * the signup Svelte component stays focused on rendering. The
 * client:
 *
 *   1. POSTs to /v1/account/invite.
 *   2. If the relay replies altcha_required, lazy-loads the PoW
 *      solver (separate chunk, only fetched when needed), solves
 *      the challenge in a Web Worker, and retries the invite
 *      call with the solution.
 *   3. Returns the invite_token string.
 *
 * The caller then passes invite_token alongside the op body to
 * createAccount().
 *
 * Error shape: every failure mode surfaces a stable `code`
 * string matching the relay's response codes. The UI maps codes
 * directly to i18n keys — no message parsing.
 */

import { MORPHIT_RELAY_ORIGIN, resolveOrigin } from '$net/config';

import type { AltchaChallenge, AltchaSolution } from './altchaSolver';

/** Phases the UI wants to know about. Used to drive the
 *  "Verifying you're human..." → "Verified ✓" transitions. */
export type SignupPhase = 'fetching_invite' | 'solving_altcha' | 'altcha_solved' | 'broadcasting';

export type SignupProgress = (phase: SignupPhase) => void;

/** Signup failure codes. A subset mirrors relay response codes
 *  directly; the rest are client-local (network, unexpected). */
export type SignupErrorCode =
	// Relay-originated (invite endpoint)
	| 'signups_disabled'
	| 'daily_ceiling_reached'
	| 'invite_rate_limited'
	| 'altcha_bad_solution'
	| 'altcha_bad_signature'
	| 'altcha_expired'
	| 'altcha_malformed'
	| 'altcha_replayed'
	// Relay-originated (create endpoint)
	| 'rate_limited'
	| 'rate_limited_daily'
	| 'spacing_cooldown'
	| 'relay_out_of_funds'
	| 'invite_required'
	| 'invite_malformed'
	| 'invite_bad_signature'
	| 'invite_expired'
	| 'invite_ip_mismatch'
	| 'invite_already_used'
	| 'malformed_operation'
	| 'name_not_allowed'
	| 'name_high_value'
	| 'name_sequential_pattern'
	| 'invalid_pubkey'
	| 'duplicate_submission'
	| 'already_registered'
	| 'chain_unavailable'
	| 'broadcast_failed'
	// Client-local
	| 'unreachable'
	| 'altcha_unsolvable';

export interface SignupError {
	code: SignupErrorCode;
	/** Additional context from the relay when available (e.g.
	 *  retry_after_minutes for spacing_cooldown, resets_at for
	 *  ceiling). Opaque bag — the UI reads only the fields it
	 *  cares about. */
	details?: Record<string, unknown>;
}

/**
 * Call /v1/account/invite and return the issued invite_token.
 * Handles altcha_required transparently by lazy-loading the
 * solver and retrying once.
 */
export async function fetchInvite(onProgress: SignupProgress = () => {}): Promise<string> {
	onProgress('fetching_invite');

	const baseUrl = `${resolveOrigin(MORPHIT_RELAY_ORIGIN)}/v1/account/invite`;

	let res: Response;
	try {
		res = await fetch(baseUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
	} catch {
		throw { code: 'unreachable' } satisfies SignupError;
	}
	const body = (await res.json().catch(() => ({}))) as {
		status?: string;
		code?: string;
		invite_token?: string;
		challenge?: AltchaChallenge;
		retry_after_minutes?: number;
		resets_at?: string;
	};

	if (res.ok && body.status === 'issued' && body.invite_token) {
		return body.invite_token;
	}

	if (body.status === 'altcha_required' && body.challenge) {
		// Lazy-load the PoW solver. Split chunk — users who
		// never hit this branch never download it.
		onProgress('solving_altcha');
		const { solveAltcha } = await import('./altchaSolver');
		let solution: AltchaSolution;
		try {
			solution = await solveAltcha(body.challenge);
		} catch {
			throw { code: 'altcha_unsolvable' } satisfies SignupError;
		}
		onProgress('altcha_solved');

		// Retry with the solution.
		let retryRes: Response;
		try {
			retryRes = await fetch(baseUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ altcha_solution: solution })
			});
		} catch {
			throw { code: 'unreachable' } satisfies SignupError;
		}
		const retryBody = (await retryRes.json().catch(() => ({}))) as {
			status?: string;
			code?: string;
			invite_token?: string;
		};
		if (retryRes.ok && retryBody.status === 'issued' && retryBody.invite_token) {
			return retryBody.invite_token;
		}
		throw {
			code: (retryBody.code as SignupErrorCode) ?? 'broadcast_failed'
		} satisfies SignupError;
	}

	// Any other rejection: surface the code.
	const err: SignupError = {
		code: (body.code as SignupErrorCode) ?? 'broadcast_failed',
		details: {}
	};
	if (typeof body.retry_after_minutes === 'number') {
		err.details = { retry_after_minutes: body.retry_after_minutes };
	}
	if (typeof body.resets_at === 'string') {
		err.details = { ...(err.details ?? {}), resets_at: body.resets_at };
	}
	throw err;
}

/**
 * POST to /v1/account/create with the invite token + op. On
 * success returns { blockNum, trxId }. On failure throws a
 * SignupError.
 */
export async function createAccount(params: {
	invite_token: string;
	op: unknown;
	onProgress?: SignupProgress;
}): Promise<{ blockNum: number; trxId: string }> {
	params.onProgress?.('broadcasting');

	const url = `${resolveOrigin(MORPHIT_RELAY_ORIGIN)}/v1/account/create`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				invite_token: params.invite_token,
				op: params.op
			})
		});
	} catch {
		throw { code: 'unreachable' } satisfies SignupError;
	}
	const body = (await res.json().catch(() => ({}))) as {
		status?: string;
		code?: string;
		block_num?: number;
		trx_id?: string;
		retry_after_minutes?: number;
		resets_at?: string;
	};
	if (res.ok && body.status === 'broadcast') {
		return {
			blockNum: body.block_num ?? 0,
			trxId: body.trx_id ?? ''
		};
	}
	const err: SignupError = {
		code: (body.code as SignupErrorCode) ?? 'broadcast_failed',
		details: {}
	};
	if (typeof body.retry_after_minutes === 'number') {
		err.details = { retry_after_minutes: body.retry_after_minutes };
	}
	if (typeof body.resets_at === 'string') {
		err.details = { ...(err.details ?? {}), resets_at: body.resets_at };
	}
	throw err;
}
