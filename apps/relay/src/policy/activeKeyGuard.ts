/**
 * The relay's own key, checked against the chain.
 *
 * The relay signs every account_create, welcome bonus, power-up and delegation
 * with the key in its keystore. If that key is not on the relay account's
 * ACTIVE authority (a posting key pasted at install, another account's key, an
 * account_update on the chain since), every one of those is rejected by the
 * chain — and until now the relay started anyway, accepted signups and queued
 * payments that could never go through, and said nothing until the first
 * rejection. `edit-active-key` and the docs said the relay checked this at
 * startup; it did not.
 *
 * Now, at startup and every RECHECK_MS after, the public key of the unlocked
 * key is compared with the keys the chain lists for the account (as two RPC
 * operators agree — BlurtClient.activeAuthorityAgreed — so one node cannot
 * stop the relay by naming other keys or by saying the account does not
 * exist). An OWNER key is accepted: the chain takes an owner signature where
 * the active one is required. On a definite mismatch the relay REFUSES TO
 * SIGN: signups answer "signups unavailable" and queued payments stay queued
 * (nothing is lost; they go out once the key is right). It does NOT exit: the
 * unit restarts the relay every 5 s for ever (Restart=always,
 * StartLimitIntervalSec=0), so an exit would be a silent crash loop that also
 * takes down everything that does not sign — health, name checks, Web Push and
 * offline notices. Instead one plain log line says what is wrong and the exact
 * command that fixes it, repeated at every check while it lasts, and
 * /v1/health (local callers) shows `active_key`.
 *
 * A definite verdict STAYS until another definite one replaces it (review,
 * 2026-10-29). A check nobody answered (the nodes could not be asked, or did
 * not agree) changes nothing: it used to overwrite a mismatch with "unknown",
 * so for the next minute the relay signed again with a key the chain had just
 * been seen to reject — payouts were rejected, used up their retries and were
 * escalated to the operator. "An unanswered check refuses nothing" holds only
 * while there is no earlier definite verdict. Only a definite "this key is
 * right" (or a definitely different answer from the chain, e.g. its active
 * authority now names other accounts) ends a refusal. While checks go
 * unanswered the key is asked about again sooner.
 *
 * With only ONE RPC operator configured, the chain can confirm the key is
 * right but never that it is wrong: one node (a node still replaying the chain
 * answers "no such account" for everyone) must not stop the relay. That
 * answer is "unknown", with a warning that says why.
 */
import type { ActiveAuthorityView } from '../blurt/client.ts';

/** How often the key is checked again while it matches or mismatches. */
export const ACTIVE_KEY_RECHECK_MS = 10 * 60_000;
/** How soon it is asked again when the chain could not answer. */
export const ACTIVE_KEY_RETRY_MS = 60_000;

export type ActiveKeyState =
	| { readonly state: 'unchecked' }
	| { readonly state: 'ok'; readonly checkedAt: number }
	| {
			readonly state: 'mismatch';
			readonly checkedAt: number;
			/** What the chain says the key is instead (null: not this account's). */
			readonly foundAs: 'posting' | 'memo' | null;
			/** The account does not exist on the chain at all. */
			readonly noAccount: boolean;
			/** The key file does not hold a usable private key at all. */
			readonly badKey?: boolean;
			/** The key IS on the active authority, but its weight is below the
			 *  authority's threshold: it cannot sign alone. */
			readonly belowThreshold?: { readonly weight: number; readonly threshold: number };
	  }
	| {
			readonly state: 'unknown';
			readonly checkedAt: number;
			readonly why: string;
			/** True when the chain DID answer (two operators agreed) and the answer
			 *  itself cannot decide — e.g. the active authority names other
			 *  accounts. False when nobody answered or the nodes did not agree. */
			readonly answered?: boolean;
	  };

export interface ActiveKeyGuardLog {
	info(event: string, ctx?: Record<string, unknown>): void;
	warn(event: string, ctx?: Record<string, unknown>): void;
	error(event: string, ctx?: Record<string, unknown>): void;
}

/** What one operator alone cannot be trusted to say. */
const SINGLE_OPERATOR_WHY =
	'only one Blurt RPC operator is configured for this relay, so an answer that the key is not on the account cannot be confirmed by a second operator (add more nodes to MORPHIT_RELAY_BLURT_RPC or MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS)';

/** Decide one check. PURE. */
export function judgeActiveKey(
	publicKey: string | null,
	view: ActiveAuthorityView | null,
	now: number
): ActiveKeyState {
	if (publicKey === null)
		return { state: 'mismatch', checkedAt: now, foundAs: null, noAccount: false, badKey: true };
	if (view === null)
		return {
			state: 'unknown',
			checkedAt: now,
			why: 'the Blurt RPC nodes could not be asked, or did not agree',
			answered: false
		};
	if (view.absent === true)
		return view.single === true
			? { state: 'unknown', checkedAt: now, why: SINGLE_OPERATOR_WHY, answered: false }
			: { state: 'mismatch', checkedAt: now, foundAs: null, noAccount: true };
	if (view.active.includes(publicKey) || view.owner.includes(publicKey))
		return { state: 'ok', checkedAt: now };
	if (view.delegated)
		return {
			state: 'unknown',
			checkedAt: now,
			why: 'the account lets other accounts sign for it, so a key that is not listed may still be valid',
			answered: view.single !== true
		};
	if (view.single === true)
		return { state: 'unknown', checkedAt: now, why: SINGLE_OPERATOR_WHY, answered: false };
	const listed = (view.activeListed ?? []).find(([k]) => k === publicKey);
	if (listed !== undefined)
		return {
			state: 'mismatch',
			checkedAt: now,
			foundAs: null,
			noAccount: false,
			belowThreshold: { weight: listed[1], threshold: view.activeThreshold ?? 1 }
		};
	return {
		state: 'mismatch',
		checkedAt: now,
		foundAs: view.posting.includes(publicKey) ? 'posting' : view.memo === publicKey ? 'memo' : null,
		noAccount: false
	};
}

/** Where the relay's account name is set (the files its unit sources; the
 *  later one wins), for the "no such account" fix. */
const ACCOUNT_SETTING_FIX =
	'On this server: sudo nano /etc/morphit/relay.env and /opt/morphit/morphit.env (the line MORPHIT_RELAY_ACCOUNT=…), then sudo systemctl restart morphit-relay';

export class ActiveKeyGuard {
	private current: ActiveKeyState = { state: 'unchecked' };
	/** The latest check went unanswered while an earlier definite verdict
	 *  stands (that verdict is kept). Null when the latest check answered. */
	private unanswered: { readonly at: number; readonly why: string } | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(
		private readonly opts: {
			readonly account: string;
			/** null: the unlocked key is not a valid private key at all. */
			readonly publicKey: string | null;
			readonly lookup: (account: string) => Promise<ActiveAuthorityView | null>;
			readonly log: ActiveKeyGuardLog;
			readonly now?: () => number;
			readonly recheckMs?: number;
			readonly retryMs?: number;
		}
	) {}

	/** True only on a DEFINITE mismatch: the relay must not sign then. */
	signingRefused(): boolean {
		return this.current.state === 'mismatch';
	}

	/** For /v1/health (local callers). All of it is public data: the account
	 *  name, the PUBLIC key, and what the chain says about them. */
	status(): Record<string, unknown> {
		const s = this.current;
		return {
			state: s.state,
			account: this.opts.account,
			public_key: this.opts.publicKey,
			...(s.state !== 'unchecked' ? { checked_at: new Date(s.checkedAt).toISOString() } : {}),
			...(s.state === 'mismatch' && s.foundAs !== null ? { found_as: s.foundAs } : {}),
			...(s.state === 'mismatch' && s.belowThreshold !== undefined
				? {
						found_as: 'active_below_threshold',
						weight: s.belowThreshold.weight,
						threshold: s.belowThreshold.threshold
					}
				: {}),
			...(s.state === 'mismatch' && s.noAccount ? { no_account: true } : {}),
			...(s.state === 'mismatch' && s.badKey === true ? { bad_key: true } : {}),
			...(s.state === 'unknown' ? { why: s.why } : {}),
			...(this.unanswered !== null
				? {
						latest_check: 'unanswered',
						latest_check_at: new Date(this.unanswered.at).toISOString(),
						latest_check_why: this.unanswered.why
					}
				: {})
		};
	}

	/** The plain words for a mismatch: what is wrong, and the fix. */
	private describe(m: Extract<ActiveKeyState, { state: 'mismatch' }>): {
		problem: string;
		fix: string;
	} {
		const { account, publicKey } = this.opts;
		const pasteActive = `On this server: sudo morphit-ops edit-active-key — paste the ACTIVE private key of @${account} — then sudo systemctl restart morphit-relay`;
		if (m.badKey === true)
			return {
				problem: 'The key file this relay unlocked does not hold a valid Blurt private key.',
				fix: pasteActive
			};
		if (m.noAccount)
			return {
				problem: `The account @${account} does not exist on the Blurt chain (two RPC operators agree).`,
				fix: ACCOUNT_SETTING_FIX
			};
		if (m.belowThreshold !== undefined)
			return {
				problem:
					`The key this relay holds (public key ${publicKey}) is listed on @${account}'s active authority, ` +
					`but cannot sign alone: its weight is ${m.belowThreshold.weight}, below the threshold ${m.belowThreshold.threshold}.`,
				fix:
					`On this server: sudo morphit-ops edit-active-key — paste an ACTIVE private key of @${account} that can sign alone — ` +
					`then sudo systemctl restart morphit-relay (or, in your Blurt wallet, give this key weight ${m.belowThreshold.threshold} on @${account}'s active authority)`
			};
		return {
			problem:
				m.foundAs === 'posting'
					? `The key this relay holds is @${account}'s POSTING key, not its ACTIVE key.`
					: m.foundAs === 'memo'
						? `The key this relay holds is @${account}'s MEMO key, not its ACTIVE key.`
						: `The key this relay holds (public key ${publicKey}) is not one of @${account}'s active keys on the Blurt chain.`,
			fix: pasteActive
		};
	}

	/** One check now. Logs on every mismatch, and when the state changes. */
	async check(): Promise<ActiveKeyState> {
		const now = (this.opts.now ?? Date.now)();
		let view: ActiveAuthorityView | null;
		try {
			view = this.opts.publicKey === null ? null : await this.opts.lookup(this.opts.account);
		} catch {
			view = null;
		}
		const before = this.current;
		const judged = judgeActiveKey(this.opts.publicKey, view, now);
		const { account, publicKey } = this.opts;
		// Nobody answered (or the nodes did not agree): an earlier DEFINITE
		// verdict stands. Only an answer replaces an answer.
		const definiteBefore = before.state === 'ok' || before.state === 'mismatch';
		if (judged.state === 'unknown' && judged.answered !== true && definiteBefore) {
			const firstMiss = this.unanswered === null;
			this.unanswered = { at: now, why: judged.why };
			if (firstMiss)
				this.opts.log.warn('active_key_check_unanswered', {
					account,
					why: judged.why,
					effect:
						before.state === 'mismatch'
							? 'Signing stays stopped: the last answer from the chain was that this key cannot sign for the account. The key is checked again shortly.'
							: 'Signing goes on: the last answer from the chain was that this key is right. The key is checked again shortly.'
				});
			if (before.state === 'mismatch') this.logMismatch(before);
			return before;
		}
		this.unanswered = null;
		this.current = judged;
		if (judged.state === 'mismatch') {
			// Every check while it lasts — the one line that must not scroll away.
			this.logMismatch(judged);
		} else if (judged.state === 'ok' && before.state !== 'ok') {
			this.opts.log.info('active_key_matches_chain', { account, public_key: publicKey });
		} else if (
			judged.state === 'unknown' &&
			(before.state !== 'unknown' || before.why !== judged.why)
		) {
			this.opts.log.warn('active_key_check_unanswered', {
				account,
				why: judged.why,
				effect: 'Signing goes on as normal; the key is checked again shortly.'
			});
		}
		return judged;
	}

	private logMismatch(m: Extract<ActiveKeyState, { state: 'mismatch' }>): void {
		const { problem, fix } = this.describe(m);
		this.opts.log.error('active_key_not_on_chain', {
			account: this.opts.account,
			public_key: this.opts.publicKey,
			problem,
			effect:
				'The relay is running but signs nothing: new signups are refused and queued payments wait (none are lost) until the key is right.',
			fix
		});
	}

	/** Check now, then again on a timer (sooner while unanswered). The relay
	 *  does not wait for the first check before it serves: until it is done the
	 *  state is `unchecked`, which refuses nothing. */
	start(): Promise<ActiveKeyState> {
		const first = this.check();
		const schedule = (): void => {
			if (this.stopped) return;
			const ms =
				this.unanswered !== null ||
				this.current.state === 'unknown' ||
				this.current.state === 'unchecked'
					? (this.opts.retryMs ?? ACTIVE_KEY_RETRY_MS)
					: (this.opts.recheckMs ?? ACTIVE_KEY_RECHECK_MS);
			this.timer = setTimeout(() => {
				void this.check().finally(schedule);
			}, ms);
			this.timer.unref?.();
		};
		void first.finally(schedule);
		return first;
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
}
