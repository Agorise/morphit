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
 *          salt:        <32 random hex + `?expires=` + epoch-ms>
 *          challenge:   SHA-256(salt + target_number)
 *          signature:   HMAC-SHA256(server_secret,
 *                         salt + ':' + challenge + ':' + maxnumber)
 *          maxnumber:   <difficulty ceiling>
 *        }
 *
 *   2. Client brute-forces N in [0, maxnumber] looking for
 *      SHA-256(salt + N) === challenge. Average cost
 *      maxnumber/2 hashes.
 *
 *   3. Client submits the solution payload (same fields plus
 *      `number: N`). Server verifies:
 *      - The salt has the exact shape we issue and the number
 *        is an integer in [0, maxnumber].
 *      - The signature over salt, challenge and maxnumber
 *        matches — proves we issued this exact challenge. The
 *        salt MUST be covered: challenge = SHA-256(salt + N),
 *        so with a signature over the challenge alone, digits
 *        could be moved between `number` and the end of `salt`
 *        without changing the challenge — several "different"
 *        solutions from one solve, and an expiry (parsed from
 *        the salt) the client could push out at will.
 *      - The submitted number actually hashes to the challenge
 *        — proves the client did the work.
 *      - The challenge hasn't been solved before — prevents
 *        submitting the same solution twice.
 *      - The salt's (signed) `expires=` timestamp is still in
 *        the future — prevents using very-old challenges.
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
	/** Recently-verified challenges + their expiry. Single-use
	 *  semantics — no solution can be replayed. Pruned lazily
	 *  when expired.
	 *
	 *  Size cap: even though entries auto-expire on a janitor
	 *  schedule, an attacker burning legitimate altcha solutions
	 *  faster than the janitor sweeps could grow this map
	 *  arbitrarily.  The janitor runs every ttlMs/4 (75s default);
	 *  in that window an attacker doing ~1k verified solutions/s
	 *  could deposit 75k entries.  Cap at 100k — well above
	 *  legitimate steady-state, well below memory pressure.
	 *  When the cap is reached, the oldest entry (Map iteration
	 *  is insertion order in JS) is evicted before insertion. */
	private readonly usedChallenges = new Map<string, number>();
	private static readonly MAX_USED_CHALLENGES = 100_000;
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
		const signature = this.sign(salt, challenge).toString('hex');
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
			!Number.isSafeInteger(solution.number) ||
			solution.number < 0 ||
			solution.number > this.maxnumber
		) {
			return { ok: false, code: 'altcha_malformed' };
		}

		// Shape check: exactly what issue() mints, nothing appended.
		const shape = SALT_SHAPE.exec(solution.salt);
		if (!shape || !/^[0-9a-f]{64}$/.test(solution.signature)) {
			return { ok: false, code: 'altcha_malformed' };
		}

		// Signature check over salt, challenge and maxnumber: proves
		// this exact challenge — expiry included — was minted by us.
		const expected = this.sign(solution.salt, solution.challenge);
		const actual = Buffer.from(solution.signature, 'hex');
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			return { ok: false, code: 'altcha_bad_signature' };
		}

		// Expiry check: the signed `?expires=<ms>` in the salt.
		const exp = Number.parseInt(shape[1]!, 10);
		if (!Number.isFinite(exp) || exp <= this.clock.now()) {
			return { ok: false, code: 'altcha_expired' };
		}

		// Replay check: each challenge is single-use.
		if (this.usedChallenges.has(solution.challenge)) {
			return { ok: false, code: 'altcha_replayed' };
		}

		// Solution check: does SHA-256(salt + number) actually
		// equal the challenge? If so, the client really did the
		// work.
		const recomputed = sha256Hex(solution.salt + solution.number.toString());
		if (recomputed !== solution.challenge) {
			return { ok: false, code: 'altcha_bad_solution' };
		}

		// All good. Record the challenge as used so it can't be
		// replayed.  Enforce the size cap before insert: if we're
		// at MAX_USED_CHALLENGES and this is a new challenge (not
		// already present — checked above via .has()), drop the
		// oldest entry.
		//
		// Security trade-off: evicting an entry whose `exp` is
		// still in the future grants a replay window for that
		// specific signed solution until expiry.  An attacker who
		// wants to exploit this would need: (1) a signed solution
		// in hand they've already used once; (2) the ability to
		// burn ~100k other legitimate solutions to force their
		// own eviction; (3) to time the replay before their
		// challenge expires (5 min default ttl).  Cost-prohibitive for the
		// gain of a single extra signup attempt; acceptable.
		// Janitor evicts on expiry, keeping steady-state below
		// the cap under any honest load.
		if (this.usedChallenges.size >= AltchaService.MAX_USED_CHALLENGES) {
			const oldestKey = this.usedChallenges.keys().next().value;
			if (oldestKey !== undefined) {
				this.usedChallenges.delete(oldestKey);
			}
		}
		this.usedChallenges.set(solution.challenge, exp);
		return { ok: true };
	}

	/** HMAC over everything the client must not change: the salt (which
	 *  carries the expiry), the challenge, and the difficulty. */
	private sign(salt: string, challenge: string): Buffer {
		return createHmac('sha256', this.secret)
			.update(`${salt}:${challenge}:${this.maxnumber}`)
			.digest();
	}

	close(): void {
		if (this.janitor) {
			clearInterval(this.janitor);
			this.janitor = null;
		}
	}

	private sweep(): void {
		const now = this.clock.now();
		for (const [challenge, exp] of this.usedChallenges) {
			if (exp <= now) this.usedChallenges.delete(challenge);
		}
	}
}

/** The only salt shape issue() mints: 16 random bytes as hex, then the
 *  expiry in epoch-ms. Anything else — digits appended, a second
 *  `?expires=`, whitespace — is refused before the signature is checked. */
const SALT_SHAPE = /^[0-9a-f]{32}\?expires=(\d{1,15})$/;

function sha256Hex(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}
