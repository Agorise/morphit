/**
 * Default signup-anomaly probe.
 *
 * When the operator-balance scanner fires a LOW_BALANCE alert
 * on the relay account, this probe fetches the relay's
 * /v1/health?verbose=1 endpoint, reads signup_stats, and
 * returns a structured verdict on whether signup volume looks
 * anomalous enough to recommend the operator flip the kill-
 * switch (MORPHIT_RELAY_SIGNUP_ENABLED=false).
 *
 * The probe is injectable (via
 * OperatorAccountBalanceScanConfig.signupAnomalyProbe) so tests
 * can substitute a stub, and operators running unusual
 * topologies can write their own.
 *
 * Heuristic:
 *   - If signup is already disabled → no recommendation.
 *   - If the CURRENT UTC hour's signup count ≥ 1/3 of the
 *     daily ceiling, that's a surge (normally signups spread
 *     across the day).
 *   - If the current hour's count meaningfully exceeds the
 *     day's peak hour so far AND is ≥ 5 signups, surge.
 *   - Otherwise: no recommendation.
 *
 * Deliberately simple. "Recommend" is advisory — operator
 * still makes the call. False negatives (miss a real drain)
 * are worse than false positives (nag the operator once for a
 * legitimate busy hour), which is why both thresholds are on
 * the conservative side of triggering.
 */

import { logger } from '$log';

import type { SignupAnomaly } from './operatorAccountBalanceScanner.ts';

const log = logger('signup-anomaly');

/** Shape of the relay's /v1/health?verbose=1 response we care
 *  about. Other fields (version, uptime, balance, etc.) are
 *  ignored by this probe. */
interface RelayHealthVerboseBody {
	signup_stats?: {
		enabled?: boolean;
		daily_ceiling?: number;
		successful_today?: number;
		current_hour_count?: number;
		peak_hour_count?: number;
		/** Peak excluding the current hour.  Present on relay
		 *  builds with the Finding N22 fix; absent on older
		 *  relays (the probe falls back to peak_hour_count, which
		 *  has the structural-unreachability bug — log-only fail
		 *  open until both sides upgrade). */
		peak_other_hours?: number;
		resets_at?: string;
	};
}

/** Cap on the relay /v1/health response body.  Real responses
 *  are <1 KB; 16 KiB is 16x normal and well above anything a
 *  healthy relay would emit, while still bounding any pathology
 *  (a misbehaving relay echoing back a large error page, etc.). */
const SIGNUP_PROBE_MAX_BODY_BYTES = 16 * 1024;

/** Build a probe that fetches the relay's /v1/health?verbose=1
 *  over HTTP and judges anomaly. The relayHealthUrl should be
 *  something like `http://127.0.0.1:8080/v1/health?verbose=1`
 *  for a colocated deployment — the indexer and relay typically
 *  live on the same host. */
export function buildSignupAnomalyProbe(
	relayHealthUrl: string,
	opts: { timeoutMs?: number } = {}
): () => Promise<SignupAnomaly> {
	const timeoutMs = opts.timeoutMs ?? 5000;
	return async () => {
		// Small abort-controller wrapper so a sluggish relay
		// doesn't hang the scan loop.
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), timeoutMs);
		try {
			// cp159 F-indexer-4 — `redirect: 'manual'` + named UA.
			// The relay URL is operator-config (sibling process,
			// typically colocated), but defense-in-depth via these
			// headers matches the cp146-style finding shape.  A
			// misconfigured relay URL that redirects elsewhere
			// should be an operator-visible failure, not a silent
			// follow.
			const res = await fetch(relayHealthUrl, {
				signal: controller.signal,
				redirect: 'manual',
				headers: {
					accept: 'application/json',
					'user-agent': 'morphit-indexer/signup-anomaly-probe'
				}
			});
			if (!res.ok) {
				return {
					probed: false,
					recommendKillSwitch: false,
					message: `relay /v1/health returned ${res.status}; anomaly check skipped`
				};
			}
			// cp159 F-indexer-4 — bound the body size before parse.
			// Relay /v1/health responses are <1 KB; the 16 KiB cap
			// catches any pathology (e.g. a misbehaving relay
			// echoing a large error page) without affecting any
			// healthy response.  res.text() is bounded because the
			// abort fires on overrun via the upstream signal; we
			// add the post-read length check as belt-and-braces.
			const rawText = await res.text();
			if (rawText.length > SIGNUP_PROBE_MAX_BODY_BYTES) {
				log.warn('relay_health_body_too_large', {
					length: rawText.length,
					cap: SIGNUP_PROBE_MAX_BODY_BYTES
				});
				return {
					probed: false,
					recommendKillSwitch: false,
					message: `relay /v1/health response exceeded size cap; anomaly check skipped`
				};
			}
			let body: RelayHealthVerboseBody;
			try {
				body = JSON.parse(rawText) as RelayHealthVerboseBody;
			} catch {
				return {
					probed: false,
					recommendKillSwitch: false,
					message: `relay /v1/health returned non-JSON body; anomaly check skipped`
				};
			}
			if (!body.signup_stats) {
				return {
					probed: false,
					recommendKillSwitch: false,
					message:
						'relay /v1/health did not include signup_stats (verbose mode disabled or old version); anomaly check skipped'
				};
			}
			return judgeAnomaly(body.signup_stats);
		} catch (err) {
			log.warn('probe_failed', {}, err);
			return {
				probed: false,
				recommendKillSwitch: false,
				message: `relay /v1/health unreachable (${err instanceof Error ? err.message : String(err)}); anomaly check skipped`
			};
		} finally {
			clearTimeout(t);
		}
	};
}

/** Pure decision logic. Exposed for unit testing. */
export function judgeAnomaly(
	stats: NonNullable<RelayHealthVerboseBody['signup_stats']>
): SignupAnomaly {
	const enabled = stats.enabled ?? true;
	const ceiling = stats.daily_ceiling ?? 0;
	const current = stats.current_hour_count ?? 0;
	const peak = stats.peak_hour_count ?? 0;
	// Per Finding N22: the prior code compared `current` against
	// `peak`, but `peakHourCount` includes the current hour itself.
	// Once a fresh spike becomes the new peak, the comparison is
	// structurally unreachable.  Prefer `peak_other_hours` (peak
	// excluding the current hour); fall back to `peak` only on
	// pre-N22 relays.
	const peakOther = stats.peak_other_hours ?? peak;
	const today = stats.successful_today ?? 0;

	const base: SignupAnomaly = {
		probed: true,
		signupEnabled: enabled,
		currentHourCount: current,
		peakHourCount: peak,
		successfulToday: today,
		dailyCeiling: ceiling,
		recommendKillSwitch: false,
		message: ''
	};

	if (!enabled) {
		return {
			...base,
			message: 'Signup is already disabled on this relay (kill-switch active).'
		};
	}

	// Threshold 1: current hour burned ≥ 1/3 of the daily
	// ceiling. A normal day spreads signups across 24 hours —
	// seeing a third of a day's capacity in one hour is a surge
	// signal regardless of past peaks.
	const ceilingShareThreshold = ceiling > 0 ? Math.max(5, Math.ceil(ceiling / 3)) : 999;
	if (current >= ceilingShareThreshold) {
		return {
			...base,
			recommendKillSwitch: true,
			message:
				`Current UTC hour has ${current} signups against a daily ceiling of ${ceiling} — ` +
				'that rate would exhaust the ceiling in under 3 hours. Consider setting ' +
				'MORPHIT_RELAY_SIGNUP_ENABLED=false while you investigate.'
		};
	}

	// Threshold 2: current hour exceeds the day's peak hour by
	// ≥2x AND has at least 5 signups. Catches a spike that
	// wouldn't trip the ceiling-share threshold but is
	// anomalous relative to today's normal.  Compares against
	// peakOther (peak excluding current hour) — see N22.
	if (current >= 5 && peakOther > 0 && current >= peakOther * 2) {
		return {
			...base,
			recommendKillSwitch: true,
			message:
				`Current UTC hour has ${current} signups, more than twice today's prior peak (${peakOther}). ` +
				'This may be a coordinated signup spike. Consider setting ' +
				'MORPHIT_RELAY_SIGNUP_ENABLED=false while you investigate.'
		};
	}

	return {
		...base,
		message: `Signup volume looks normal: ${current} this hour, peak ${peak}/hour, ${today}/${ceiling} today.`
	};
}
