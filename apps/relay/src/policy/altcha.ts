/**
 * Morphit relay — Altcha proof-of-work challenge service.
 *
 * Self-hosted Altcha implementation (https://altcha.org), no
 * external dependencies. Altcha is a lightweight alternative
 * to CAPTCHA: the client's browser solves a SHA-256 proof-of-
 * work puzzle, which typically takes 1-3 seconds of
 * (invisible) background work but is expensive at scale for
 * a bot-farm attacker.
 *
 * Protocol (server → client → server):
 *
 *   1. Client requests a challenge. Server returns:
 *        {
 *          algorithm:   "SHA-256"
 *          salt:        <random hex + `?expires=` + epoch-ms>
 *          challenge:   SHA-256(salt + target_number)
 *          signature:   HMAC-SHA256(server_secret, challenge)
 *          maxnumber:   <difficulty ceiling>
 *        }
 *
 *   2. Client brute-forces N in [0, maxnumber] looking for
 *      SHA-256(salt + N) === challenge. Average cost
 *      maxnumber/2 hashes.
 *
 *   3. Client submits the solution payload (same fields plus
 *      `number: N`). Server verifies:
 *      - The signature on challenge matches — proves the
 *        challenge was issued by us and not a replay from a
 *        third party.
 *      - The submitted number actually hashes to the challenge
 *        — proves the client did the work.
 *      - The salt hasn't been seen before — prevents
 *        submitting the same solution twice.
 *      - The salt's `expires=` timestamp is still in the
 *        future — prevents using very-old challenges.
 *
 * We deliberately do NOT use the `@altcha/lib` NPM package.
 * The protocol is simple enough that a 150-line
 * implementation is more auditable than depending on a
 * third-party package that could introduce supply-chain risk
 * for a security-sensitive endpoint.
 *
 * Difficulty: the `maxnumber` parameter controls cost. A
 * modern browser manages ~1M SHA-256/sec single-threaded, so
 * maxnumber=1_000_000 gives ~0.5s average. We default to
 * 2_000_000 (~1s average) for the normal bump, configurable
 * for operators who want more or less friction.
 */

import { createHmac, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { logger } from '$log';
import { defaultClock, type Clock } from './clock.ts';

const log = logger('altcha');

/** Challenge payload served to the client. Field names match
 *  the Altcha spec so off-the-shelf `altcha-widget` code works
 *  as the client. */
export interface AltchaChallenge {
	algorithm: 'SHA-256';
	challenge: string; // hex
	salt: string; // random hex + ?expires=ms
	signature: string; // hex
	maxnumber: number;
}

/** What the client submits back. Exactly the challenge fields
 *  plus the solved `number`. */
export interface AltchaSolution {
	algorithm: 'SHA-256';
	challenge: string;
	salt: string;
	signature: string;
	number: number;
}

export type AltchaVerifyResult =
	| { ok: true }
	| { ok: false; code: 'altcha_malformed' }
	| { ok: false; code: 'altcha_bad_signature' }
	| { ok: false; code: 'altcha_bad_solution' }
	| { ok: false; code: 'altcha_expired' }
	| { ok: false; code: 'altcha_replayed' };

export class AltchaService {
	private readonly secret: Buffer;
	private readonly maxnumber: number;
	private readonly ttlMs: number;
	private readonly clock: Clock;
	/** Recently-verified salts + their expiry. Single-use
	 *  semantics — no solution can be replayed. Pruned lazily
	 *  when expired.
	 *
	 *  Size cap: even though entries auto-expire on a janitor
	 *  schedule, an attacker burning legitimate altcha solutions
	 *  faster than the janitor sweeps could grow this map
	 *  arbitrarily.  The janitor runs every ttlMs/4 (75s default);
	 *  in that window an attacker doing ~1k verified solutions/s
	 *  could deposit 75k salts.  Cap at 100k — well above
	 *  legitimate steady-state, well below memory pressure.
	 *  When the cap is reached, the oldest entry (Map iteration
	 *  is insertion order in JS) is evicted before insertion. */
	private readonly usedSalts = new Map<string, number>();
	private static readonly MAX_USED_SALTS = 100_000;
	private janitor: NodeJS.Timeout | null = null;

	constructor(
		opts: {
			secret?: Buffer | null;
			/** PoW difficulty. Average solve cost ≈ maxnumber/2
			 *  SHA-256 operations. Default 2_000_000 → ~1 second on
			 *  a modern browser. */
			maxnumber?: number;
			/** How long a challenge remains valid once issued.
			 *  Default 5 min — long enough for a legitimate user to
			 *  solve it without rush, short enough that stockpiling
			 *  is impractical. */
			ttlMs?: number;
			/** Optional clock for testing.  Production passes the
			 *  default clock; tests pass a ManualClock for
			 *  deterministic expiry assertions. */
			clock?: Clock;
		} = {}
	) {
		if (opts.secret) {
			this.secret = opts.secret;
			log.info('altcha_secret_persistent');
		} else {
			this.secret = randomBytes(32);
			log.warn('altcha_secret_ephemeral', {
				note: 'MORPHIT_RELAY_ALTCHA_HMAC_SECRET not set — using a random per-boot secret. In-flight challenges will be invalidated on restart.'
			});
		}
		this.maxnumber = opts.maxnumber ?? 2_000_000;
		this.ttlMs = opts.ttlMs ?? 5 * 60_000;
		this.clock = opts.clock ?? defaultClock;

		const interval = Math.max(10_000, Math.floor(this.ttlMs / 4));
		this.janitor = setInterval(() => this.sweep(), interval);
		this.janitor.unref?.();
	}

	/** Issue a new challenge. Pick a target number N in [0,
	 *  maxnumber) and return the challenge hash along with a
	 *  signed salt. The client doesn't learn N until they
	 *  brute-force it.
	 *
	 *  Uses crypto.randomInt rather than Math.random because the
	 *  latter (xorshift128+ in V8) has recoverable state — an
	 *  attacker who legitimately solves a few challenges could
	 *  predict future target numbers and skip the PoW work
	 *  (Finding N19). */
	issue(): AltchaChallenge {
		const targetNumber = randomInt(0, this.maxnumber);
		const expiresAt = this.clock.now() + this.ttlMs;
		const saltNonce = randomBytes(16).toString('hex');
		const salt = `${saltNonce}?expires=${expiresAt}`;
		const challenge = sha256Hex(salt + targetNumber.toString());
		const signature = createHmac('sha256', this.secret).update(challenge).digest('hex');
		return {
			algorithm: 'SHA-256',
			challenge,
			salt,
			signature,
			maxnumber: this.maxnumber
		};
	}

	/** Verify a client-submitted solution. Returns ok: true if
	 *  the challenge is ours, not expired, not replayed, and
	 *  the number actually solves the PoW. */
	verify(solution: AltchaSolution): AltchaVerifyResult {
		if (
			!solution ||
			solution.algorithm !== 'SHA-256' ||
			typeof solution.challenge !== 'string' ||
			typeof solution.salt !== 'string' ||
			typeof solution.signature !== 'string' ||
			typeof solution.number !== 'number' ||
			!Number.isFinite(solution.number)
		) {
			return { ok: false, code: 'altcha_malformed' };
		}

		// Signature check: proves this challenge was minted by
		// us, not forged.
		const expected = createHmac('sha256', this.secret).update(solution.challenge).digest();
		let actual: Buffer;
		try {
			actual = Buffer.from(solution.signature, 'hex');
		} catch {
			return { ok: false, code: 'altcha_malformed' };
		}
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			return { ok: false, code: 'altcha_bad_signature' };
		}

		// Expiry check: parse `?expires=<ms>` out of the salt.
		const expMatch = solution.salt.match(/\?expires=(\d+)/);
		if (!expMatch) {
			return { ok: false, code: 'altcha_malformed' };
		}
		const exp = Number.parseInt(expMatch[1]!, 10);
		if (!Number.isFinite(exp) || exp <= this.clock.now()) {
			return { ok: false, code: 'altcha_expired' };
		}

		// Replay check: each salt is single-use.
		if (this.usedSalts.has(solution.salt)) {
			return { ok: false, code: 'altcha_replayed' };
		}

		// Solution check: does SHA-256(salt + number) actually
		// equal the challenge? If so, the client really did the
		// work.
		const recomputed = sha256Hex(solution.salt + solution.number.toString());
		if (recomputed !== solution.challenge) {
			return { ok: false, code: 'altcha_bad_solution' };
		}

		// All good. Record the salt as used so it can't be
		// replayed.  Enforce the size cap before insert: if we're
		// at MAX_USED_SALTS and this is a new salt (not already
		// present — checked above via .has()), drop the oldest entry.
		//
		// Security trade-off: evicting an entry whose `exp` is
		// still in the future grants a replay window for that
		// specific signed solution until expiry.  An attacker who
		// wants to exploit this would need: (1) a signed solution
		// in hand they've already used once; (2) the ability to
		// burn ~100k other legitimate solutions to force their
		// own eviction; (3) to time the replay before their salt
		// expires (5 min default ttl).  Cost-prohibitive for the
		// gain of a single extra signup attempt; acceptable.
		// Janitor evicts on expiry, keeping steady-state below
		// the cap under any honest load.
		if (this.usedSalts.size >= AltchaService.MAX_USED_SALTS) {
			const oldestKey = this.usedSalts.keys().next().value;
			if (oldestKey !== undefined) {
				this.usedSalts.delete(oldestKey);
			}
		}
		this.usedSalts.set(solution.salt, exp);
		return { ok: true };
	}

	close(): void {
		if (this.janitor) {
			clearInterval(this.janitor);
			this.janitor = null;
		}
	}

	private sweep(): void {
		const now = this.clock.now();
		for (const [salt, exp] of this.usedSalts) {
			if (exp <= now) this.usedSalts.delete(salt);
		}
	}
}

function sha256Hex(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}
