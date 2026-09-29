/**
 * Relay /v1/account/create (and invite) error code → the i18n key the
 * register-name page shows. Pure, so the mapping is unit-tested
 * (signupErrorKey.test.ts); the page adds its own side effects (an
 * 'already_registered' also marks the name as taken).
 *
 * Unknown codes fall back to 'broadcast_failed' ("the chain rejected…").
 * A code the relay can send must therefore be mapped here explicitly, or
 * the user is told the wrong thing.
 */
export function signupErrorI18nKey(code: string): string {
	switch (code) {
		case 'already_registered':
			return 'onboarding.register_name.errors.already_registered';
		case 'name_not_allowed':
			return 'onboarding.register_name.errors.name_not_allowed';
		case 'name_high_value':
			return 'onboarding.register_name.errors.name_high_value';
		case 'name_sequential_pattern':
			return 'onboarding.register_name.errors.name_sequential_pattern';
		case 'invalid_pubkey':
			return 'onboarding.register_name.errors.invalid_pubkey';
		case 'rate_limited':
		case 'invite_rate_limited':
			return 'onboarding.register_name.errors.rate_limited';
		case 'rate_limited_daily':
			return 'onboarding.register_name.errors.rate_limited_daily';
		case 'spacing_cooldown':
			// Uses {minutes} interpolation from messageArgs.
			return 'onboarding.register_name.errors.spacing_cooldown';
		case 'signups_disabled':
			return 'onboarding.register_name.errors.signups_disabled';
		case 'daily_ceiling_reached':
			return 'onboarding.register_name.errors.daily_ceiling_reached';
		case 'relay_out_of_funds':
			return 'onboarding.register_name.errors.relay_out_of_funds';
		// v1.20.0 (D4): the chain's account fee jumped past the operator's
		// expectation; signups are paused until the operator reviews it.
		case 'relay_fee_spike':
			return 'onboarding.register_name.errors.relay_fee_spike';
		// v1.20.0 (D2): the relay could not tell whether the account landed.
		// Retrying with the SAME name is safe: if it exists with this owner
		// key, the relay answers success (`status: 'broadcast'`,
		// `note: 'already_created'`), which createAccount() treats as success.
		case 'broadcast_outcome_unknown':
			return 'onboarding.register_name.errors.broadcast_outcome_unknown';
		case 'chain_unavailable':
			return 'onboarding.register_name.errors.chain_unavailable';
		case 'duplicate_submission':
			return 'onboarding.register_name.errors.duplicate_submission';
		// Invite-token failures — all surface the same user-facing
		// message: "your signup token expired, please try again."
		// The relay's differentiated codes help operators debug
		// server-side; users just need to know "retry and it'll work."
		case 'invite_required':
		case 'invite_malformed':
		case 'invite_bad_signature':
		case 'invite_expired':
		case 'invite_ip_mismatch':
		case 'invite_already_used':
			return 'onboarding.register_name.errors.invite_problem';
		// Altcha failures — similarly folded to one user message.
		case 'altcha_bad_solution':
		case 'altcha_bad_signature':
		case 'altcha_expired':
		case 'altcha_malformed':
		case 'altcha_replayed':
		case 'altcha_unsolvable':
			return 'onboarding.register_name.errors.altcha_problem';
		case 'unreachable':
			return 'onboarding.register_name.errors.unreachable';
		case 'broadcast_failed':
		default:
			return 'onboarding.register_name.errors.broadcast_failed';
	}
}
