/**
 * Morphit relay — ACT (Account Creation Token) auto-minter (ADR-0010 §5).
 *
 * The relay creates accounts by CONSUMING pre-minted ACTs
 * (`pending_claimed_accounts`); each `create_claimed_account` burns one.
 * When the buffer runs low the relay rejects signups with
 * `relay_out_of_funds` (see api/health.ts MIN_PENDING_CLAIMED_ACCOUNTS).
 * Historically the buffer was refilled by an operator running
 * `scripts/mint-acts.ts` by hand (or a weekly systemd timer).
 *
 * This module makes that automatic: a periodic in-process loop that
 * watches `pending_claimed_accounts` and, when it dips below the
 * low-water mark, mints ACTs back up to a target — paying the chain
 * `account_creation_fee` in LIQUID BLURT from the relay account.
 *
 * IT NEVER touches the operator's BLURT reserve: it only spends what's
 * available ABOVE `minBlurtReserve`, so welcome bonuses, loyalty
 * delegations, and dust refills are never starved by minting. When the
 * relay is too low on BLURT to mint, the auto-minter does NOT mint and
 * logs a structured `automint_insufficient_blurt` warning; the operator
 * is actively notified by the INDEXER's operator-balance scanner
 * (operatorAccountBalanceScanner → Matrix), whose alert threshold should
 * sit above the point where minting stalls so the operator can top up
 * BLURT before signups are affected. See docs/OPERATIONS.md §19.
 *
 * OPT-IN: disabled unless MORPHIT_RELAY_AUTOMINT_ENABLED=true, so an
 * operator who upgrades without reading the release notes sees no new
 * on-chain spending. The decision logic (`planActMint`) is a pure
 * function with no I/O — fully unit-tested in test/actAutoMinter.test.ts.
 */

import type { BlurtClient } from './client.ts';
import { logger } from '$log';

const log = logger('act-automint');

/** Parse a Graphene liquid-balance string "N.NNN BLURT" → number, or
 *  null if it doesn't match. Mirrors the fee parse in mint-acts.ts. */
export function parseBlurtBalance(raw: string): number | null {
	const m = /^([\d.]+)\s+BLURT$/.exec(raw.trim());
	if (!m) return null;
	const n = Number.parseFloat(m[1]!);
	return Number.isFinite(n) ? n : null;
}

export interface ActAutoMintConfig {
	/** Master switch. False = never mint (the default). */
	readonly enabled: boolean;
	/** Desired ACT buffer. Each cycle tops up toward this. */
	readonly targetActs: number;
	/** Mint only when pending_claimed_accounts drops below this. Must be
	 *  greater than the relay's MIN_PENDING_CLAIMED_ACCOUNTS gate and
	 *  no greater than targetActs. */
	readonly lowWaterActs: number;
	/** Milliseconds between cycles. */
	readonly intervalMs: number;
	/** Hard cap on ACTs minted in a single cycle — bounds the BLURT
	 *  burn and the broadcast burst even if target is far above pending. */
	readonly maxPerCycle: number;
	/** Liquid BLURT to keep untouched (for welcome bonuses / dust /
	 *  fees). Minting only ever spends BLURT above this floor. */
	readonly minBlurtReserve: number;
}

export type AutoMintReason =
	| 'above_low_water'
	| 'minted'
	| 'partial_insufficient_blurt'
	| 'insufficient_blurt';

export interface MintPlan {
	/** How many ACTs to mint this cycle. */
	readonly mintCount: number;
	/** How many we WANTED (target − pending, capped at maxPerCycle). */
	readonly desired: number;
	/** How many the spendable BLURT (above reserve) could afford. */
	readonly affordable: number;
	readonly reason: AutoMintReason;
}

/**
 * PURE decision function — no I/O, fully unit-testable. Given the
 * current relay state, decide how many ACTs to mint this cycle.
 *
 *   pending >= lowWater                  → mint 0 (above_low_water)
 *   below low-water, can afford the gap  → mint the gap (minted)
 *   below low-water, can afford some     → mint what we can
 *                                          (partial_insufficient_blurt)
 *   below low-water, can't afford one    → mint 0 (insufficient_blurt)
 *
 * `desired` is bounded by both the target gap AND maxPerCycle.
 * `affordable` is floor((liquidBlurt − reserve) / feeBlurt), never
 * dipping into the reserve.
 */
export function planActMint(s: {
	pending: number;
	target: number;
	lowWater: number;
	maxPerCycle: number;
	liquidBlurt: number;
	feeBlurt: number;
	reserve: number;
}): MintPlan {
	if (s.pending >= s.lowWater) {
		return { mintCount: 0, desired: 0, affordable: 0, reason: 'above_low_water' };
	}
	const desired = Math.max(0, Math.min(s.target - s.pending, s.maxPerCycle));
	if (desired === 0) {
		// pending below lowWater but already >= target (only possible if
		// lowWater > target, which config validation forbids) — treat as
		// nothing to do rather than mint a negative count.
		return { mintCount: 0, desired: 0, affordable: 0, reason: 'above_low_water' };
	}
	const spendable = s.liquidBlurt - s.reserve;
	const affordable = s.feeBlurt > 0 ? Math.max(0, Math.floor(spendable / s.feeBlurt)) : 0;
	const mintCount = Math.min(desired, affordable);
	if (mintCount <= 0) {
		return { mintCount: 0, desired, affordable, reason: 'insufficient_blurt' };
	}
	if (mintCount < desired) {
		return { mintCount, desired, affordable, reason: 'partial_insufficient_blurt' };
	}
	return { mintCount, desired, affordable, reason: 'minted' };
}

export class ActAutoMinter {
	private timer: NodeJS.Timeout | null = null;
	/** In-flight guard: a mint batch can outlast intervalMs (each ACT is
	 *  a separate broadcast). Never run two cycles concurrently. */
	private running = false;

	constructor(
		private readonly blurt: BlurtClient,
		private readonly relayAccount: string,
		private readonly activeKeyWif: string,
		private readonly fallbackFeeBlurt: number,
		private readonly config: ActAutoMintConfig
	) {}

	/** Start the periodic loop. No-op (logs once) when disabled. Kicks an
	 *  immediate cycle on boot so a relay starting low tops up without
	 *  waiting a full interval, then runs every intervalMs. */
	start(): void {
		if (!this.config.enabled) {
			log.info('automint_disabled', {});
			return;
		}
		log.info('automint_enabled', {
			target_acts: this.config.targetActs,
			low_water_acts: this.config.lowWaterActs,
			interval_ms: this.config.intervalMs,
			max_per_cycle: this.config.maxPerCycle,
			min_blurt_reserve: this.config.minBlurtReserve
		});
		this.timer = setInterval(() => {
			void this.runCycle();
		}, this.config.intervalMs);
		this.timer.unref?.();
		void this.runCycle();
	}

	close(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** One mint cycle: read state → plan → mint. Errors are logged and
	 *  swallowed — a background loop must never crash the relay. */
	async runCycle(): Promise<void> {
		if (this.running) {
			log.info('automint_cycle_skipped_in_flight', {});
			return;
		}
		this.running = true;
		try {
			const acct = await this.blurt.getAccount(this.relayAccount);
			if (!acct) {
				log.warn('automint_account_missing', { account: this.relayAccount });
				return;
			}
			const liquidBlurt = parseBlurtBalance(acct.balance);
			if (liquidBlurt === null) {
				log.warn('automint_balance_unparseable', {
					account: this.relayAccount,
					raw_balance: acct.balance
				});
				return;
			}

			// Current chain fee; fall back to the operator-configured value
			// when the chain read fails (same fallback the relay uses for
			// account creation). A chain hiccup must not block minting.
			let feeBlurt = this.fallbackFeeBlurt;
			try {
				const props = await this.blurt.getChainProperties();
				const m = /^([\d.]+)\s+BLURT$/.exec(props.account_creation_fee.trim());
				const parsed = m ? Number.parseFloat(m[1]!) : Number.NaN;
				if (Number.isFinite(parsed) && parsed > 0) feeBlurt = parsed;
			} catch {
				// keep fallbackFeeBlurt
			}

			const plan = planActMint({
				pending: acct.pending_claimed_accounts,
				target: this.config.targetActs,
				lowWater: this.config.lowWaterActs,
				maxPerCycle: this.config.maxPerCycle,
				liquidBlurt,
				feeBlurt,
				reserve: this.config.minBlurtReserve
			});

			if (plan.reason === 'above_low_water') {
				log.info('automint_above_low_water', {
					pending: acct.pending_claimed_accounts,
					low_water: this.config.lowWaterActs
				});
				return;
			}

			if (plan.reason === 'insufficient_blurt') {
				// Below low-water AND can't afford one ACT without dipping
				// into the reserve. Do NOT mint. The operator is notified by
				// the indexer's operator-balance scanner (→ Matrix); its
				// threshold should sit above this point. See OPERATIONS.md §19.
				log.warn('automint_insufficient_blurt', {
					account: this.relayAccount,
					pending: acct.pending_claimed_accounts,
					desired: plan.desired,
					liquid_blurt: liquidBlurt,
					fee_blurt: feeBlurt,
					reserve: this.config.minBlurtReserve
				});
				return;
			}

			// 'minted' or 'partial_insufficient_blurt' → mint mintCount ACTs,
			// one op each. Stop the batch on the first failure so we don't
			// hammer a failing chain; partial success is recoverable next cycle.
			let succeeded = 0;
			let failed = 0;
			for (let i = 1; i <= plan.mintCount; i++) {
				try {
					const r = await this.blurt.broadcastClaimAccount({
						creator: this.relayAccount,
						creatorActiveWif: this.activeKeyWif,
						feeBlurt
					});
					succeeded++;
					log.info('automint_minted', { i, of: plan.mintCount, trx_id: r.id });
				} catch (err) {
					failed++;
					log.error('automint_mint_failed', { i, of: plan.mintCount }, err);
					break;
				}
			}

			log.info('automint_cycle_done', {
				minted: succeeded,
				failed,
				pending_before: acct.pending_claimed_accounts,
				target: this.config.targetActs,
				fee_blurt: feeBlurt
			});

			if (plan.reason === 'partial_insufficient_blurt' && failed === 0) {
				log.warn('automint_partial_insufficient_blurt', {
					account: this.relayAccount,
					minted: succeeded,
					desired: plan.desired,
					liquid_blurt: liquidBlurt,
					fee_blurt: feeBlurt,
					reserve: this.config.minBlurtReserve
				});
			}
		} catch (err) {
			log.error('automint_cycle_error', {}, err);
		} finally {
			this.running = false;
		}
	}
}
