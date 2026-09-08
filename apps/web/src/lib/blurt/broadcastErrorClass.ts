/**
 * broadcastErrorClass — turn ANY broadcast failure into an exact,
 * actionable UI message. The rule (the maintainer, v1.16.5): the interface must always
 * tell the user/operator precisely WHAT went wrong and HOW to fix it. We never
 * fall back to a dead-end "try again", and we never ask anyone to open DevTools.
 *
 * Pure + deterministic so it can be unit-tested. The component resolves the
 * returned i18n key (under `common.broadcast_err.*`) with `$_`.
 */
import { AccountBindingError } from './accountBinding';
import { ChainRejectedError, BroadcastUnavailableError, BroadcastError } from './broadcastTransport';

export interface BroadcastErrorCopy {
	/** i18n key under `common.broadcast_err`. */
	readonly key: string;
	readonly values?: Record<string, string>;
}

/** Trim + collapse whitespace + cap length, so a raw chain/transport message is
 *  safe to drop into a UI string (Svelte auto-escapes, so no XSS risk). */
export function shortDetail(s: string, max = 200): string {
	const t = (s ?? '').trim().replace(/\s+/g, ' ');
	if (t.length === 0) return '';
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Map a chain-rejection reason to an ACTIONABLE message key, or null to show
 *  the raw reason verbatim. Blurt has NO resource-credit/mana gate on ops — it
 *  charges a per-operation BLURT fee (a flat fee + a size-based bandwidth fee),
 *  paid from liquid BLURT; an account that can't cover it is rejected. */
export function classifyChainReason(
	reason: string
): 'low_blurt' | 'too_large' | 'auth' | 'tx_expired' | 'duplicate' | null {
	const r = reason.toLowerCase();
	// Device clock skew — a graphene tx is valid for only a few seconds, so a
	// clock that's off makes every signed op expire before it lands. Cryptic;
	// give the real fix (sync the clock).
	if (/expir|tapos|transaction is too old|reference block|drifted|out of range.*block/.test(r))
		return 'tx_expired';
	if (/duplicate|already (exists|been broadcast|processed)|is a dupe/.test(r)) return 'duplicate';
	if (/insufficient (balance|funds)|not enough (balance|blurt|funds)|unable to (pay|cover)|can(no|')?t (pay|afford)|fee (exceeds|too high|greater)|balance too low|does not have (enough|sufficient)|missing amount/.test(r))
		return 'low_blurt';
	if (/too.?large|too big|serialized.*size|maximum size|size limit|payload.*(size|large)|exceeds.*(size|bytes|block)/.test(r))
		return 'too_large';
	if (/missing (required )?(posting|active|owner) auth|invalid signature|irrelevant signature|not authorized|no matching (key|auth)|authority/.test(r))
		return 'auth';
	return null;
}

/**
 * Classify any thrown broadcast error into a UI copy descriptor.
 * @param err     the caught error
 * @param account the user's Blurt account (for key_mismatch guidance)
 */
export function classifyBroadcastError(err: unknown, account: string): BroadcastErrorCopy {
	// Human account↔identity mismatch — never a chain rejection.
	if (err instanceof AccountBindingError) {
		if (err.kind === 'key_not_in_authority' || err.kind === 'ambiguous')
			return { key: 'wrong_account', values: { account: err.candidates[0] ?? '' } };
		if (err.kind === 'no_account_for_key') return { key: 'no_account_for_key' };
		return { key: 'lookup_failed' };
	}
	if (err instanceof BroadcastError && err.code === 'key_mismatch')
		return { key: 'key_mismatch', values: { account } };
	if (err instanceof BroadcastError && (err.code === 'no_account' || err.code === 'locked'))
		return { key: err.code };

	// Transport couldn't reach the instance / chain — the most common opaque
	// failure (offline or still-syncing instance). Now named + actionable, and for
	// a WAF status we name the EXACT layer + fix (the maintainer: the code must say what's
	// wrong, not a generic "couldn't reach" — timeapp's recurring avatar 413).
	if (err instanceof BroadcastUnavailableError) {
		const detail = shortDetail(err.message);
		const status = /\b(41[0-9]|4[0-9][0-9]|5[0-9][0-9])\b/.exec(err.message ?? '')?.[1] ?? '';
		if (status === '413') return { key: 'waf_too_large', values: { detail } };
		if (status === '403') return { key: 'waf_blocked', values: { detail } };
		return { key: 'unreachable', values: { detail } };
	}

	// Chain rejected the tx — classify the reason into an actionable fix where we
	// recognise it, else surface the raw reason.
	if (err instanceof ChainRejectedError) {
		const reason = shortDetail(err.message);
		const cause = classifyChainReason(err.message ?? '');
		if (cause) return { key: cause, values: { reason } };
		return { key: 'rejected', values: { reason } };
	}

	// Anything else: surface the raw detail so it is NEVER opaque. Only when the
	// error carries no message at all do we use the bare generic string.
	const detail = shortDetail(err instanceof Error ? err.message : String(err ?? ''));
	return detail ? { key: 'generic_detail', values: { detail } } : { key: 'generic' };
}

/**
 * One-call resolver used by EVERY chain-write surface (settings, orders,
 * feedback, chat, operator-register, …) so a broadcast failure reads identically
 * everywhere. Pass the component's `$_` as `t`. Classifies the error and
 * localizes it under `common.broadcast_err.*`. Surfaces layer their own
 * DOMAIN-specific errors (validation, fee-preview) BEFORE calling this.
 */
export function broadcastErrorMessage(
	t: (key: string, opts?: { values?: Record<string, string> }) => string,
	err: unknown,
	account: string
): string {
	const { key, values } = classifyBroadcastError(err, account);
	return t(`common.broadcast_err.${key}`, values ? { values } : undefined);
}
