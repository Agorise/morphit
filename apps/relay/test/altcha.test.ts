import { describe, expect, it, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

import { AltchaService, type AltchaSolution } from '../src/policy/altcha.ts';
import { ManualClock } from '../src/policy/clock.ts';

/** Brute-force solve an Altcha challenge. Mirrors what a browser-
 *  side widget does. */
function solve(challenge: {
	salt: string;
	challenge: string;
	signature: string;
	maxnumber: number;
}): AltchaSolution {
	for (let n = 0; n <= challenge.maxnumber; n++) {
		const h = createHash('sha256')
			.update(challenge.salt + n.toString())
			.digest('hex');
		if (h === challenge.challenge) {
			return {
				algorithm: 'SHA-256',
				salt: challenge.salt,
				challenge: challenge.challenge,
				signature: challenge.signature,
				number: n
			};
		}
	}
	throw new Error('altcha: no solution found within maxnumber');
}

describe('AltchaService', () => {
	const services: AltchaService[] = [];
	afterEach(() => {
		for (const s of services) s.close();
		services.length = 0;
	});

	function make(opts?: ConstructorParameters<typeof AltchaService>[0]) {
		// Small maxnumber keeps test-solving fast. A bot couldn't
		// care less — we're testing correctness, not PoW strength.
		const svc = new AltchaService({ maxnumber: 1000, ...opts });
		services.push(svc);
		return svc;
	}

	it('issues a well-formed challenge', () => {
		const svc = make();
		const c = svc.issue();
		expect(c.algorithm).toBe('SHA-256');
		expect(c.challenge).toMatch(/^[0-9a-f]{64}$/);
		expect(c.signature).toMatch(/^[0-9a-f]{64}$/);
		expect(c.salt).toMatch(/^[0-9a-f]+\?expires=\d+$/);
		expect(c.maxnumber).toBe(1000);
	});

	it('verify: accepts a valid solution', () => {
		const svc = make();
		const c = svc.issue();
		const sol = solve(c);
		const r = svc.verify(sol);
		expect(r.ok).toBe(true);
	});

	it('verify: rejects with altcha_bad_solution when number does not hash to challenge', () => {
		const svc = make();
		const c = svc.issue();
		const sol = solve(c);
		// Tamper with the solved number.
		const tampered: AltchaSolution = { ...sol, number: sol.number + 1 };
		const r = svc.verify(tampered);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('altcha_bad_solution');
	});

	it('verify: rejects with altcha_bad_signature when signature tampered', () => {
		const svc = make();
		const c = svc.issue();
		const sol = solve(c);
		// Flip the FIRST character of the signature.
		//
		// altcha currently encodes sig as hex (4-bit-per-digit, no
		// padding-equivalent positions), so any single-char flip
		// changes the decoded bytes — last-char flip works fine
		// here.  But Part 85 documented the broader anti-pattern
		// for base64url HMACs, where last-char flips ~6% of the
		// time decode to the same bytes.  Using first-char flip
		// here keeps the test resilient if altcha's encoding ever
		// changes to base64url (no diff to the assertion's intent).
		const sig = sol.signature;
		const tamperedSig = (sig.at(0) === 'a' ? 'b' : 'a') + sig.slice(1);
		const r = svc.verify({ ...sol, signature: tamperedSig });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('altcha_bad_signature');
	});

	it('verify: single-use — second verify with same salt fails altcha_replayed', () => {
		const svc = make();
		const c = svc.issue();
		const sol = solve(c);

		const first = svc.verify(sol);
		expect(first.ok).toBe(true);

		const second = svc.verify(sol);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.code).toBe('altcha_replayed');
	});

	it('verify: rejects altcha_expired for past-expiry challenges', () => {
		// Item 6 / Audit Part 27: ManualClock makes this
		// deterministic and instant.  Previously: real
		// setTimeout(150) on a 100ms TTL.
		const clock = new ManualClock('2026-05-15T12:00:00Z');
		const svc = make({ ttlMs: 100, clock });
		const c = svc.issue();
		const sol = solve(c);
		// Advance past expiry and verify.
		clock.advance(150);
		const r = svc.verify(sol);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('altcha_expired');
	});

	it('verify: rejects altcha_malformed on missing fields', () => {
		const svc = make();
		const badCases: unknown[] = [
			{},
			{ algorithm: 'SHA-256' },
			{ algorithm: 'MD5', challenge: 'x', salt: 'x', signature: 'x', number: 0 },
			{
				algorithm: 'SHA-256',
				challenge: 'x',
				salt: 'x',
				signature: 'not-hex!!!',
				number: 0
			}
		];
		for (const bad of badCases) {
			const r = svc.verify(bad as AltchaSolution);
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(['altcha_malformed', 'altcha_bad_signature', 'altcha_expired']).toContain(r.code);
			}
		}
	});

	it("different service instances cannot verify each other's challenges", () => {
		const s1 = make();
		const s2 = make();
		const c = s1.issue();
		const sol = solve(c);
		const r = s2.verify(sol);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('altcha_bad_signature');
	});
});
