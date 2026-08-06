/**
 * Morphit indexer — /v1/attestor-eligibility/:account endpoint.
 *
 * Returns whether a given account can currently attest under
 * the Finding I eligibility rules (loyalty + age, OR/AND per
 * phase). Used by the frontend order-detail page to decide
 * whether to show the attest button and, if not, what to
 * display in its place.
 *
 * Authentication: none. Every input the eligibility check
 * uses is public on-chain state.
 *
 * Query parameter:
 *   ?phase=launch|steady — optional phase override. Defaults
 *   to the indexer's currently-configured phase. Letting the
 *   frontend query either lets it show "you qualify under
 *   launch but not steady" hints during the transition
 *   window, if a future UX wants that.
 *
 * Response shape (ok):
 *   {
 *     account: string,
 *     phase: "launch" | "steady",
 *     eligible: boolean,
 *     reason: "loyalty" | "age" | "both" |
 *             "insufficient_loyalty_and_young_account" |
 *             "insufficient_loyalty" |
 *             "young_account" |
 *             "account_not_found",
 *     loyalty_blurt: number,
 *     age_days: number,
 *     missing_loyalty_blurt: number,
 *     days_until_eligible: number | null
 *   }
 */

import { Hono } from 'hono';

import type { Config } from '$config';
import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';
import { checkAttestorEligibility, type AttestationPhase } from '$indexer/attestorEligibility';

export function attestorEligibilityRoute(db: Database, config: Config): Hono {
	const app = new Hono();

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const phaseParam = c.req.query('phase');
		let phase: AttestationPhase;
		if (phaseParam === undefined) {
			phase = config.attestationPhase;
		} else if (phaseParam === 'launch' || phaseParam === 'steady') {
			phase = phaseParam;
		} else {
			return c.json(errorBody('bad_request', 'phase must be launch or steady'), 400);
		}

		const result = await checkAttestorEligibility(account, phase, db, new Date());

		return c.json({
			account,
			phase,
			eligible: result.eligible,
			reason: result.reason,
			loyalty_blurt: result.loyaltyBlurt,
			age_days: result.ageDays,
			missing_loyalty_blurt: result.eligible ? 0 : result.missingLoyaltyBlurt,
			days_until_eligible: result.eligible ? 0 : result.daysUntilEligible
		});
	});

	return app;
}
