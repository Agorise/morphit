/**
 * Morphit relay — Blurt chain client.
 *
 * Thin wrapper over @beblurt/dblurt.  Provides:
 *   - Endpoint rotation across multiple Blurt RPC nodes via
 *     `@morphit/rpc-pool`'s EndpointPool (latency-aware: fastest
 *     EWMA known endpoint first, exponential cooldown ladder on
 *     transport failure, optional adaptive hedging for user-facing
 *     calls only — broadcasts never hedge).
 *   - A small, relay-specific API: account lookup, chain properties
 *     for the current account_creation_fee, and account creation.
 *
 * Nothing about user private keys ever touches this module.  The only
 * key it handles is the relay's own active key (passed in explicitly
 * from main.ts).
 *
 * cp165: migrated from the bespoke rotation logic (round-robin +
 * raw cooldown counter, ~80 lines of private code at the bottom of
 * this class) to the shared `@morphit/rpc-pool` package.  Same
 * primitives the indexer's BlurtClient now uses, so future audits
 * only need to verify one rotation implementation.
 */

import { Client, PrivateKey } from '@beblurt/dblurt';
import { EndpointPool } from '@morphit/rpc-pool';
import { VERSION } from '../api/health.ts';
import { morphitUserAgent } from './userAgent.ts';

/** Parse a Graphene asset string like "1234.567 BLURT" or
 *  "9876543.210987 VESTS" into its raw integer amount (BigInt),
 *  decimal scale (number of digits after the decimal point), and
 *  ticker. Returns null on any unexpected shape — caller decides
 *  whether that's a fatal error. */
function parseGrapheneAmount(s: string): { amount: bigint; scale: number; ticker: string } | null {
	const m = /^(-?\d+)(?:\.(\d+))?\s+([A-Z]+)$/.exec(s.trim());
	if (!m) return null;
	const integerPart = m[1]!;
	const fractional = m[2] ?? '';
	const ticker = m[3]!;
	try {
		const amount = BigInt(integerPart + fractional);
		return { amount, scale: fractional.length, ticker };
	} catch {
		return null;
	}
}

/** Format a BigInt amount (in smallest-unit integer form) as a
 *  fixed-decimal string at the given scale. E.g. (1234567n, 3)
 *  => "1234.567", (5n, 6) => "0.000005". Exported for tests. */
export function formatBigIntWithScale(amount: bigint, scale: number): string {
	if (scale <= 0) return amount.toString();
	const negative = amount < 0n;
	const abs = negative ? -amount : amount;
	const raw = abs.toString();
	const padded = raw.length > scale ? raw : raw.padStart(scale + 1, '0');
	const intPart = padded.slice(0, padded.length - scale);
	const fracPart = padded.slice(padded.length - scale);
	const body = `${intPart}.${fracPart}`;
	return negative ? `-${body}` : body;
}

/** Subset of the Blurt account object the relay needs. The full
 *  response has 80+ fields; we project down to what we use. */
export interface AccountInfo {
	readonly name: string;
	readonly created: string;
	/** Liquid balance string, e.g. "423.000 BLURT". */
	readonly balance: string;
	/** Number of pre-minted Account Creation Tokens held by this
	 *  account, available for use by `create_claimed_account`.
	 *  The relay tracks this on its own account to gate signups
	 *  on ACT availability rather than BLURT balance — per
	 *  ADR-0010 §4 the relay never directly pays the chain
	 *  account-creation fee, so balance alone is the wrong gate. */
	readonly pending_claimed_accounts: number;
	/** First posting public key (BLURT-prefix base58) from the
	 *  account's posting authority.  Part 122 cp14 — needed so
	 *  the relay can verify posting-key signatures on
	 *  /v1/push/subscribe.  Absent if the chain returned an
	 *  account with no posting authority (shouldn't happen for
	 *  any real account, but defensive against malformed chain
	 *  responses).
	 *
	 *  Multi-key posting authorities exist (multisig accounts)
	 *  but in practice every Morphit user account has a single
	 *  posting key; for cp14 we accept signatures from the
	 *  first key in the authority and document that multi-key
	 *  authorities aren't fully supported for push subscribe. */
	readonly posting_pubkey: string | undefined;
}

/** Chain properties that change on witness consensus — most
 *  importantly the current fee to create a new account. */
export interface ChainProperties {
	readonly account_creation_fee: string;
	readonly maximum_block_size: number;
	readonly operation_flat_fee?: string;
	readonly bandwidth_kbytes_fee?: string;
}

/** The two DGP fields we need to convert BLURT Power (BP) →
 *  VESTS at broadcast time. Both arrive as Graphene asset
 *  strings ("123.456 BLURT", "9876543.210987 VESTS"). */
export interface VestingInfo {
	readonly total_vesting_fund_blurt: string;
	readonly total_vesting_shares: string;
}

/** Result returned from broadcastAccountCreate. Fields match the
 *  TransactionConfirmation shape dblurt returns on broadcast. */
export interface AccountCreateResult {
	readonly id: string;
	readonly block_num: number;
	readonly trx_num: number;
	readonly expired: boolean;
}

/** Fixed-shape input for account creation. The relay synthesises
 *  the rest (fee, creator) from config. */
export interface NewAccountAuthorities {
	readonly newAccountName: string;
	readonly ownerPubkey: string;
	readonly activePubkey: string;
	readonly postingPubkey: string;
	readonly memoPubkey: string;
	readonly jsonMetadata: string;
}

/** Result of analyzing whether the chain-observed
 *  account_creation_fee diverges from the operator-configured
 *  fallback by enough to warrant a warn-log.  Pure — no I/O,
 *  no logging, no class state — so it's directly testable
 *  from tsx without spinning up the dblurt rotator.
 *
 *  Cases:
 *    - kind: 'fallback'    — chain returned an unparseable
 *                            account_creation_fee; the relay
 *                            should use the configured fallback
 *                            and log loudly.
 *    - kind: 'divergent'   — chain value is parseable AND
 *                            differs from configured fallback
 *                            by more than the threshold.
 *                            Relay should warn (once per
 *                            startup) so operator updates env.
 *    - kind: 'in_range'    — chain value is parseable and
 *                            close enough to fallback.  No
 *                            log needed.
 */
export type FeeDivergenceAnalysis =
	| {
			readonly kind: 'fallback';
			readonly rawValue: unknown;
			readonly rawType: string;
	  }
	| {
			readonly kind: 'divergent';
			readonly observedBlurt: number;
			readonly configuredFallbackBlurt: number;
			readonly divergencePct: number;
	  }
	| {
			readonly kind: 'in_range';
			readonly observedBlurt: number;
			readonly configuredFallbackBlurt: number;
			readonly divergencePct: number;
	  };

/** Threshold above which the configured fallback is considered
 *  meaningfully out of sync with the chain.  Picked to ignore
 *  small witness-driven fluctuations (which historically don't
 *  happen on Blurt — the fee has been 100 BLURT for years) but
 *  catch a real change where a witness emergency-vote moves the
 *  fee by 50%+. */
export const FEE_DIVERGENCE_WARN_THRESHOLD = 0.1;

/** Pure analysis function — given a chain-returned
 *  `account_creation_fee` value and the operator's configured
 *  fallback, classify the situation for the warn-log decision.
 *
 *  Exported separately from BlurtClient so smoke tests can
 *  exercise the logic without network dependencies.  The class
 *  method `getChainProperties` calls this and decides whether
 *  to log based on the returned kind plus its own
 *  once-per-startup throttle. */
export function analyzeFeeDivergence(
	rawObservedFee: unknown,
	configuredFallbackBlurt: number
): FeeDivergenceAnalysis {
	// Parseability gate: must be a string of the form "N BLURT"
	// or "N.NNN BLURT".  Anything else (undefined, null, number
	// shape, missing ticker) → fallback.
	if (typeof rawObservedFee !== 'string') {
		return {
			kind: 'fallback',
			rawValue: rawObservedFee,
			rawType: typeof rawObservedFee
		};
	}
	const m = /^([\d.]+)\s+BLURT$/.exec(rawObservedFee);
	if (!m) {
		return {
			kind: 'fallback',
			rawValue: rawObservedFee,
			rawType: 'string'
		};
	}
	const observed = Number.parseFloat(m[1]!);
	if (
		!Number.isFinite(observed) ||
		observed <= 0 ||
		!Number.isFinite(configuredFallbackBlurt) ||
		configuredFallbackBlurt <= 0
	) {
		return {
			kind: 'fallback',
			rawValue: rawObservedFee,
			rawType: 'string'
		};
	}
	const divergence = Math.abs(observed - configuredFallbackBlurt) / configuredFallbackBlurt;
	const divergencePct = Math.round(divergence * 1000) / 10;
	if (divergence > FEE_DIVERGENCE_WARN_THRESHOLD) {
		return {
			kind: 'divergent',
			observedBlurt: observed,
			configuredFallbackBlurt,
			divergencePct
		};
	}
	return {
		kind: 'in_range',
		observedBlurt: observed,
		configuredFallbackBlurt,
		divergencePct
	};
}

export class BlurtClient {
	private readonly pool: EndpointPool;
	private readonly fallbackAccountCreationFeeBlurt: number;
	/** Throttle flag for the chain-fee-diverges-from-config warn
	 *  log (REVISIT-LIST §G).  We warn once per process startup
	 *  rather than on every poll to avoid spamming journald;
	 *  operators who restart the relay after updating their
	 *  config will see a fresh check on the first poll. */
	private divergenceWarned = false;

	constructor(endpointUrls: readonly string[], fallbackAccountCreationFeeBlurt: number) {
		if (endpointUrls.length === 0) {
			throw new Error('BlurtClient: at least one endpoint required');
		}
		if (!Number.isFinite(fallbackAccountCreationFeeBlurt) || fallbackAccountCreationFeeBlurt <= 0) {
			throw new Error(
				'BlurtClient: fallbackAccountCreationFeeBlurt must be a positive finite number'
			);
		}
		this.pool = new EndpointPool({
			endpoints: [...endpointUrls]
		});
		this.fallbackAccountCreationFeeBlurt = fallbackAccountCreationFeeBlurt;
	}

	/** Expose pool snapshot for /v1/health diagnostics. */
	endpointSnapshot(): ReturnType<EndpointPool['snapshot']> {
		return this.pool.snapshot();
	}

	/**
	 * Look up an account by name. Returns null if the account does
	 * not exist (Blurt returns an empty array, not an error, for
	 * nonexistent names).
	 *
	 * cp165 USER-FACING — called during signup availability check
	 * and user-posting-key verification (NOT the relay's key — the relay
	 * holds an active key; this method only fetches the inbound user's
	 * posting pubkey for signature verification).  Hedging on: when the primary
	 * endpoint is slow, fire a parallel request to the next-best so
	 * the user doesn't wait on the slow node.  withSignal lets the
	 * pool cancel-and-rotate within the per-call budget even though
	 * dblurt itself doesn't support AbortSignal natively.
	 */
	async getAccount(name: string): Promise<AccountInfo | null> {
		const result = await this.callWithRotation<unknown>(
			async (client, signal) => {
				// dblurt exposes getAccounts on the condenser API helper.
				return await withSignal(client.condenser.getAccounts([name]), signal);
			},
			{ hedge: true }
		);
		if (!Array.isArray(result) || result.length === 0) return null;
		const acct = result[0] as Record<string, unknown>;
		// pending_claimed_accounts is a uint32 on chain.  Some
		// older Steem-derived chains don't include the field
		// (HF20-pre); coalesce to 0 in that case so the gate
		// just denies signups (the operator can't have ACTs on
		// a chain that doesn't support them).
		const pcaRaw = acct.pending_claimed_accounts;
		const pca =
			typeof pcaRaw === 'number' && Number.isInteger(pcaRaw) && pcaRaw >= 0
				? pcaRaw
				: typeof pcaRaw === 'string' && /^\d+$/.test(pcaRaw)
					? Number(pcaRaw)
					: 0;

		// Part 122 cp14 — extract first posting public key (if any).
		// Authority shape: { weight_threshold, account_auths,
		//                    key_auths: [[pubkey_str, weight], ...] }
		// Tolerate missing/malformed values — return undefined so the
		// caller can surface a clear error instead of throwing here.
		let postingPubkey: string | undefined;
		const postingAuth = acct.posting as
			| { key_auths?: unknown }
			| undefined;
		if (postingAuth && Array.isArray(postingAuth.key_auths)) {
			const first = postingAuth.key_auths[0];
			if (Array.isArray(first) && typeof first[0] === 'string') {
				postingPubkey = first[0];
			}
		}

		return {
			name: String(acct.name ?? name),
			created: String(acct.created ?? ''),
			balance: String(acct.balance ?? '0.000 BLURT'),
			pending_claimed_accounts: pca,
			posting_pubkey: postingPubkey
		};
	}

	/** Get current witness-consensus chain properties. */
	async getChainProperties(): Promise<ChainProperties> {
		const result = await this.callWithRotation<unknown>(async (client) => {
			// dblurt exposes this as a direct RPC call on the condenser API.
			return await client.call('condenser_api', 'get_chain_properties', []);
		});
		const props = result as Record<string, unknown>;
		// Format the operator's configured fallback as a Graphene
		// asset string in case the chain returned a malformed
		// account_creation_fee.  Three-decimal scale matches Blurt
		// chain convention.
		const fallbackFeeStr = `${this.fallbackAccountCreationFeeBlurt.toFixed(3)} BLURT`;

		// Pure analysis (extracted for testability — see
		// analyzeFeeDivergence above).  This decides whether
		// the chain value is unparseable (use fallback + log
		// loudly), divergent enough to warrant a warn-log
		// (REVISIT-LIST §G — operator config is stale), or in
		// range (silent — most poll cycles).
		const analysis = analyzeFeeDivergence(
			props.account_creation_fee,
			this.fallbackAccountCreationFeeBlurt
		);

		switch (analysis.kind) {
			case 'fallback':
				console.warn(
					JSON.stringify({
						event: 'chain_props_account_creation_fee_fallback',
						raw_value: analysis.rawValue,
						raw_type: analysis.rawType,
						fallback_used: fallbackFeeStr,
						hint: 'Chain returned an unparseable account_creation_fee; relay used the operator-config fallback. Verify chain RPC endpoint health and update MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT if the witnesses changed the fee.'
					})
				);
				break;
			case 'divergent':
				// Throttled to once per process startup.
				if (!this.divergenceWarned) {
					this.divergenceWarned = true;
					console.warn(
						JSON.stringify({
							event: 'chain_props_account_creation_fee_diverges_from_config',
							observed_blurt: analysis.observedBlurt,
							configured_fallback_blurt: analysis.configuredFallbackBlurt,
							divergence_pct: analysis.divergencePct,
							hint:
								'Chain account_creation_fee differs from MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT by >10%. ' +
								'If this divergence is persistent (witnesses changed the fee), update the env variable to the chain value. ' +
								'The relay will continue using the chain value for live signups regardless; this warning is purely advisory so the operator-config stays accurate.'
						})
					);
				}
				break;
			case 'in_range':
				// Silent — happy path.
				break;
		}

		const usedFallback = analysis.kind === 'fallback';
		return {
			account_creation_fee: usedFallback ? fallbackFeeStr : String(props.account_creation_fee),
			maximum_block_size: Number(props.maximum_block_size ?? 65536),
			operation_flat_fee:
				typeof props.operation_flat_fee === 'string' ? props.operation_flat_fee : undefined,
			bandwidth_kbytes_fee:
				typeof props.bandwidth_kbytes_fee === 'string' ? props.bandwidth_kbytes_fee : undefined
		};
	}

	/**
	 * Build, sign, and broadcast an `account_create` transaction — the
	 * relay (creator/signer) pays the chain's `account_creation_fee`
	 * inline from its liquid BLURT, and the chain burns it to the null
	 * account. Blurt disabled the Account-Creation-Token model
	 * (claim_account / create_claimed_account) at HF2, so direct
	 * account_create is the ONLY way to create an account on Blurt.
	 *
	 * The fee is read fresh from the chain per call (see body) because
	 * the account_create_evaluator asserts
	 * `o.fee == median account_creation_fee` exactly.
	 *
	 * The creator (signer) is the relay itself; its active key is
	 * passed in as a WIF string. We convert to dblurt's PrivateKey
	 * exactly once per call — no long-lived key object.
	 *
	 * Returns the chain's confirmation once the transaction is in a
	 * block. Throws on any failure (chain error, signing error,
	 * all-endpoints-down, including "Insufficient balance to create
	 * account" if the relay's liquid BLURT is below the fee — the
	 * create endpoint gates on this up front via
	 * HealthService.canAcceptCreation()).
	 */
	async broadcastAccountCreate(args: {
		creator: string;
		creatorActiveWif: string;
		authorities: NewAccountAuthorities;
	}): Promise<AccountCreateResult> {
		const priv = PrivateKey.fromString(args.creatorActiveWif);

		// account_create requires the EXACT current account_creation_fee
		// (the chain evaluator asserts equality, not >=). Read it live so
		// a witness fee change can't desync us into a rejected broadcast.
		const fee = (await this.getChainProperties()).account_creation_fee;

		const op = buildAccountCreateOp(args.creator, fee, args.authorities);

		const confirmation = await this.callWithRotation(async (client) => {
			return await client.broadcast.sendOperations([op], priv);
		});

		return {
			id: String((confirmation as { id?: string }).id ?? ''),
			block_num: Number((confirmation as { block_num?: number }).block_num ?? 0),
			trx_num: Number((confirmation as { trx_num?: number }).trx_num ?? 0),
			expired: Boolean((confirmation as { expired?: boolean }).expired ?? false)
		};
	}

	/** Build, sign, and broadcast a `transfer` op sending BLURT from
	 *  the relay to `to`. Used by the welcome-bonus queue drainer
	 *  (ADR-0011 §8) to deliver 10 BLURT liquid to a new trader, and
	 *  by the low-balance auto-refill to send 1 BLURT dust.
	 *
	 *  `amountBlurt` is a plain decimal (e.g. 10 or 1.5); we
	 *  format to the "N.NNN BLURT" asset shape at the edge. */
	async broadcastTransfer(args: {
		from: string;
		fromActiveWif: string;
		to: string;
		amountBlurt: number;
		memo?: string;
	}): Promise<AccountCreateResult> {
		if (!(args.amountBlurt > 0)) {
			throw new Error(`broadcastTransfer: amount must be > 0, got ${args.amountBlurt}`);
		}
		const priv = PrivateKey.fromString(args.fromActiveWif);
		const op: [string, Record<string, unknown>] = [
			'transfer',
			{
				from: args.from,
				to: args.to,
				amount: `${args.amountBlurt.toFixed(3)} BLURT`,
				memo: args.memo ?? ''
			}
		];

		const confirmation = await this.callWithRotation(async (client) => {
			// dblurt accepts the raw op tuple as sendOperations's
			// first arg when typed broadly. Cast required because
			// its TS types are narrower than its runtime behavior.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return await client.broadcast.sendOperations([op as any], priv);
		});

		return this.shapeConfirmation(confirmation);
	}

	/** Build, sign, and broadcast a `transfer_to_vesting` op —
	 *  powers up `amountBlurt` of BLURT into the recipient's vesting
	 *  balance (BP). Used for the 10 BLURT welcome-bonus BP stake
	 *  and loyalty-milestone BP rewards (sub-phase 4c). */
	async broadcastTransferToVesting(args: {
		from: string;
		fromActiveWif: string;
		to: string;
		amountBlurt: number;
	}): Promise<AccountCreateResult> {
		if (!(args.amountBlurt > 0)) {
			throw new Error(`broadcastTransferToVesting: amount must be > 0, got ${args.amountBlurt}`);
		}
		const priv = PrivateKey.fromString(args.fromActiveWif);
		const op: [string, Record<string, unknown>] = [
			'transfer_to_vesting',
			{
				from: args.from,
				to: args.to,
				amount: `${args.amountBlurt.toFixed(3)} BLURT`
			}
		];

		const confirmation = await this.callWithRotation(async (client) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return await client.broadcast.sendOperations([op as any], priv);
		});

		return this.shapeConfirmation(confirmation);
	}

	/** Current VESTS-per-BLURT conversion factors from the chain's
	 *  DGP. Used by broadcastDelegation to convert a BP target into
	 *  the VESTS amount a delegate_vesting_shares op requires.
	 *  Fetched on each call — the ratio drifts slowly (~few bps per
	 *  day) but it's not safe to cache across broadcasts. */
	async getVestingInfo(): Promise<VestingInfo> {
		const result = await this.callWithRotation<unknown>(async (client) => {
			// dblurt exposes this on the condenser API helper, not
			// the database API helper.
			return await client.condenser.getDynamicGlobalProperties();
		});
		const dgp = result as Record<string, unknown>;
		if (
			typeof dgp.total_vesting_fund_blurt !== 'string' ||
			typeof dgp.total_vesting_shares !== 'string'
		) {
			throw new Error('getVestingInfo: DGP missing vesting fields');
		}
		return {
			total_vesting_fund_blurt: dgp.total_vesting_fund_blurt,
			total_vesting_shares: dgp.total_vesting_shares
		};
	}

	/** Fetch dynamic global properties — used at boot for the
	 *  clock-drift check (task #7).  Returns the chain's reported
	 *  head_block_time as ISO-without-Z, matching dblurt's convention.
	 *  Throws on RPC failure or missing time field. */
	async getDynamicGlobalProperties(): Promise<{ time: string }> {
		const result = await this.callWithRotation<unknown>(async (client) => {
			return await client.condenser.getDynamicGlobalProperties();
		});
		const dgp = result as Record<string, unknown>;
		if (typeof dgp.time !== 'string') {
			throw new Error('getDynamicGlobalProperties: DGP missing time field');
		}
		return { time: dgp.time };
	}

	/** Broadcast a delegate_vesting_shares op. The amountBp is the
	 *  absolute Blurt Power level to set (NOT an increment) — the
	 *  op replaces any existing delegation from delegator to
	 *  delegatee. Callers that want to add to an existing delegation
	 *  must pass the cumulative target themselves. See
	 *  apps/indexer/src/indexer/loyalty.ts for the accumulation
	 *  logic.
	 *
	 *  Conversion: VESTS = BP * (total_vesting_shares /
	 *  total_vesting_fund_blurt). We use BigInt arithmetic scaled by
	 *  1_000_000 for the intermediate multiplication to avoid
	 *  precision loss on the 6-decimal VESTS values. */
	async broadcastDelegation(args: {
		delegator: string;
		delegatorActiveWif: string;
		delegatee: string;
		amountBp: number;
	}): Promise<AccountCreateResult> {
		if (!(args.amountBp > 0)) {
			throw new Error(`broadcastDelegation: amountBp must be > 0, got ${args.amountBp}`);
		}
		if (args.delegator === args.delegatee) {
			throw new Error(
				`broadcastDelegation: refusing self-delegation ${args.delegator} -> ${args.delegatee}`
			);
		}

		const vi = await this.getVestingInfo();
		const vestsStr = this.convertBpToVests(args.amountBp, vi);

		const priv = PrivateKey.fromString(args.delegatorActiveWif);
		const op: [string, Record<string, unknown>] = [
			'delegate_vesting_shares',
			{
				delegator: args.delegator,
				delegatee: args.delegatee,
				vesting_shares: vestsStr
			}
		];
		const confirmation = await this.callWithRotation(async (client) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return await client.broadcast.sendOperations([op as any], priv);
		});
		return this.shapeConfirmation(confirmation);
	}

	/** BP-to-VESTS conversion. Pure BigInt arithmetic — no float
	 *  math at any step. The chain accepts VESTS with 6 decimals;
	 *  we compute the exact integer microvests output, then format.
	 *
	 *  Formula (in integer units):
	 *    bp_base = round(bp * 10^fund.scale)       // BP in fund's precision
	 *    vests_base = bp_base * shares.amount / fund.amount
	 *                                              // scales cancel; result in shares' precision
	 *
	 *  Division truncates toward zero, matching the chain's
	 *  inability to represent sub-microvests. At realistic
	 *  milestone BP values (10, 50, 200, 1000) the truncated
	 *  quantity is at most one microvest — economically negligible. */
	convertBpToVests(bp: number, vi: VestingInfo): string {
		const fund = parseGrapheneAmount(vi.total_vesting_fund_blurt);
		const shares = parseGrapheneAmount(vi.total_vesting_shares);
		if (fund === null || shares === null) {
			throw new Error(`convertBpToVests: unparseable DGP strings ${JSON.stringify(vi)}`);
		}
		if (fund.amount <= 0n || shares.amount <= 0n) {
			throw new Error('convertBpToVests: non-positive DGP amounts');
		}
		if (!(bp > 0)) {
			throw new Error(`convertBpToVests: bp must be > 0, got ${bp}`);
		}

		// Scale bp (Number) to a BigInt in fund's base unit. Rounding
		// here folds any sub-milliblurt input to the nearest
		// representable integer — deliberate, since the chain itself
		// can't express more precision than fund.scale for BLURT.
		const bpScaled = BigInt(Math.round(bp * Math.pow(10, fund.scale)));

		// Core ratio: bp_base * shares.amount / fund.amount.
		// Scales cancel algebraically: (units with scale fund.scale)
		// * (units with scale shares.scale) / (units with scale
		// fund.scale) = units with scale shares.scale.
		const vestsBase = (bpScaled * shares.amount) / fund.amount;

		return `${formatBigIntWithScale(vestsBase, shares.scale)} VESTS`;
	}

	/** Narrow the loose confirmation object we get from dblurt into
	 *  our AccountCreateResult shape. Shared by all broadcast
	 *  methods. */
	private shapeConfirmation(confirmation: unknown): AccountCreateResult {
		return {
			id: String((confirmation as { id?: string }).id ?? ''),
			block_num: Number((confirmation as { block_num?: number }).block_num ?? 0),
			trx_num: Number((confirmation as { trx_num?: number }).trx_num ?? 0),
			expired: Boolean((confirmation as { expired?: boolean }).expired ?? false)
		};
	}

	// ─── Endpoint rotation ─────────────────────────────────────────

	/**
	 * Invoke `fn` against a healthy endpoint, rotating on transport
	 * failure.  RPC errors (the chain rejecting the call) bubble up
	 * immediately without cooling the endpoint down — those are the
	 * caller's problem, not the endpoint's.
	 *
	 * cp165: delegates to `@morphit/rpc-pool`'s EndpointPool —
	 * latency-aware (fastest known endpoint first by EWMA), with
	 * adaptive hedging when the caller opts in via `{hedge: true}`.
	 *
	 * Hedging policy on this client:
	 *   - User-facing reads (availability check, getAccount during
	 *     signup): hedge on — instant failover under degradation.
	 *   - Broadcasts: hedge OFF unconditionally.  Two parallel
	 *     broadcasts of the same transaction would either land
	 *     twice (chain rejects the duplicate but burns a roundtrip)
	 *     or race-condition.  The single-broadcast latency is the
	 *     cost of correctness.
	 *
	 * The `signal` passed to `fn` lets callers bridge dblurt's
	 * non-cancellable API: wrap any awaited dblurt call in
	 * `withSignal(call, signal)` and the pool can cancel a slow
	 * dispatch (e.g. when hedging wins on a peer endpoint).
	 */
	private async callWithRotation<T>(
		fn: (client: Client, signal: AbortSignal) => Promise<T>,
		options: { hedge?: boolean } = {}
	): Promise<T> {
		return this.pool.call(
			async (url, signal) => {
				const client = clientFor(url);
				return fn(client, signal);
			},
			{ hedge: options.hedge === true }
		);
	}
}

/** Bridge a dblurt call (no native cancellation) to an AbortSignal.
 *  The dblurt call still runs to completion in the background if the
 *  signal aborts mid-flight; we just stop awaiting it.  Cost: one
 *  abandoned RPC per hedge — same tradeoff hedging already makes
 *  intentionally (the hedge double-fires the request anyway). */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new Error('aborted'));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			reject(new Error('aborted'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener('abort', onAbort);
				resolve(v);
			},
			(err) => {
				signal.removeEventListener('abort', onAbort);
				reject(err);
			}
		);
	});
}

/** Per-endpoint dblurt Client instance cache.  Reuse Clients across
 *  calls so we don't pay the allocation cost per request. */
const clientCache = new Map<string, Client>();
function clientFor(url: string): Client {
	let c = clientCache.get(url);
	if (c === undefined) {
		c = new Client(url, { timeout: 10_000, userAgent: morphitUserAgent(VERSION) });
		clientCache.set(url, c);
	}
	return c;
}

/**
 * Build the `account_create` op tuple (op 5). Returns the two-element
 * array dblurt expects: [opName, opBody].
 *
 * Blurt disabled the Account-Creation-Token model (claim_account /
 * create_claimed_account) at HF2, so the creator pays the
 * account_creation_fee inline and the chain burns it to the null
 * account. `fee` MUST equal the chain's current median
 * account_creation_fee (the account_create_evaluator asserts equality,
 * not >=) — broadcastAccountCreate reads it live per call.
 *
 * Wire shape per Steem/Blurt protocol (op-5 field order):
 *   ['account_create', {
 *     fee,
 *     creator,
 *     new_account_name,
 *     owner, active, posting (single-key authorities),
 *     memo_key,
 *     json_metadata
 *   }]
 *
 * Note: account_create has NO `extensions` field (unlike the retired
 * create_claimed_account).
 */
export function buildAccountCreateOp(
	creator: string,
	fee: string,
	auth: NewAccountAuthorities
): ['account_create', Record<string, unknown>] {
	// Blurt disabled BOTH claim_account and create_claimed_account at
	// hard fork 2 (the chain evaluators assert
	// "This operation is disable since hard fork 2"), so the Account-
	// Creation-Token model is dead on Blurt. Direct `account_create`
	// (op 5) is the only creation path: the creator pays the
	// account_creation_fee inline and it is burned to the null account.
	// The chain's account_create_evaluator asserts
	// `o.fee == median_props.account_creation_fee` EXACTLY (not >=), so
	// `fee` MUST be the live chain value — broadcastAccountCreate reads
	// it fresh per call. Unlike create_claimed_account, account_create
	// has NO `extensions` field (op-5 layout: fee, creator,
	// new_account_name, owner, active, posting, memo_key, json_metadata).
	return [
		'account_create',
		{
			fee,
			creator,
			new_account_name: auth.newAccountName,
			owner: singleKeyAuthority(auth.ownerPubkey),
			active: singleKeyAuthority(auth.activePubkey),
			posting: singleKeyAuthority(auth.postingPubkey),
			memo_key: auth.memoPubkey,
			json_metadata: auth.jsonMetadata
		}
	];
}

/** Helper: a single-key authority with weight 1 / threshold 1. */
function singleKeyAuthority(pubkey: string) {
	return {
		weight_threshold: 1,
		account_auths: [] as Array<[string, number]>,
		key_auths: [[pubkey, 1]] as Array<[string, number]>
	};
}
