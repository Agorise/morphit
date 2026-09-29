#!/usr/bin/env tsx
/**
 * Smoke for F3 — the invite claim guard that closes the concurrent-reuse
 * TOCTOU on account creation.
 *
 * Before F3, verify() only checked consumedNonces, and the create endpoint
 * consumed the invite ONLY after a successful broadcast (so an RPC failure
 * wouldn't burn a user's invite). Two concurrent requests presenting the
 * SAME still-valid invite could therefore both pass verify() before either
 * consumed it, yielding two accounts — and two ~102 BLURT spends from the
 * relay wallet — from one invite.
 *
 * F3 adds a synchronous tryClaim() taken immediately before the broadcast:
 *   verify() -> tryClaim() -> broadcast -> success: consume() / failure: releaseClaim()
 * Because tryClaim() is synchronous, the loser of a race is rejected before
 * it can broadcast. A crashed request that neither consumes nor releases is
 * swept after CLAIM_TTL_MS so an invite is never permanently locked.
 *
 * Coverage:
 *   - first claim succeeds; a concurrent claim of the same nonce fails
 *   - verify() rejects a claimed (in-flight) nonce as invite_already_used
 *   - releaseClaim() frees the invite for a legitimate retry
 *   - consume() is permanent (claim AND future verify rejected)
 *   - a claim held by a running create survives the sweep until the invite expires
 */
import { InviteTokenService } from '../src/policy/inviteToken.ts';
import { ManualClock } from '../src/policy/clock.ts';

let failures = 0;
let scenarios = 0;
function check(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

const IP = '203.0.113.7';
const SECRET = Buffer.from('f3-toctou-smoke-secret-key-32bytes!!', 'utf8');

function freshService(clock: ManualClock): InviteTokenService {
	return new InviteTokenService({ secret: SECRET, ttlMs: 3_600_000, clock });
}

console.log('invite-claim TOCTOU (F3) smoke:\n');

check('first tryClaim succeeds; concurrent tryClaim of the same nonce is rejected', () => {
	const clock = new ManualClock('2026-08-21T00:00:00Z');
	const svc = freshService(clock);
	const { token } = svc.issue(IP);
	const r1 = svc.verify(token, IP);
	assert(r1.ok, 'first verify should pass');
	// two requests both verified the same invite (the pre-F3 race). The claim
	// is the tie-breaker: exactly one may hold it at a time.
	assert(svc.tryClaim(r1.payload) === true, 'first claim should win');
	assert(svc.tryClaim(r1.payload) === false, 'second concurrent claim must be rejected');
});

check('verify() rejects an in-flight (claimed) nonce as invite_already_used', () => {
	const clock = new ManualClock('2026-08-21T00:00:00Z');
	const svc = freshService(clock);
	const { token } = svc.issue(IP);
	const r1 = svc.verify(token, IP);
	assert(r1.ok, 'verify ok');
	assert(svc.tryClaim(r1.payload) === true, 'claim ok');
	const r2 = svc.verify(token, IP); // concurrent request re-verifying
	assert(!r2.ok && r2.code === 'invite_already_used', 'claimed nonce must verify as already_used');
});

check('releaseClaim() frees the invite for a legitimate retry (broadcast failed)', () => {
	const clock = new ManualClock('2026-08-21T00:00:00Z');
	const svc = freshService(clock);
	const { token } = svc.issue(IP);
	const r = svc.verify(token, IP);
	assert(r.ok, 'verify ok');
	assert(svc.tryClaim(r.payload) === true, 'claim ok');
	svc.releaseClaim(r.payload); // broadcast failed
	// same invite is usable again — verify passes and a new claim succeeds
	const again = svc.verify(token, IP);
	assert(again.ok, 'released invite should verify again');
	assert(svc.tryClaim(again.payload) === true, 'released invite should be re-claimable');
});

check('consume() is permanent — claim and future verify both rejected', () => {
	const clock = new ManualClock('2026-08-21T00:00:00Z');
	const svc = freshService(clock);
	const { token } = svc.issue(IP);
	const r = svc.verify(token, IP);
	assert(r.ok, 'verify ok');
	assert(svc.tryClaim(r.payload) === true, 'claim ok');
	svc.consume(r.payload); // broadcast succeeded
	const again = svc.verify(token, IP);
	assert(!again.ok && again.code === 'invite_already_used', 'consumed invite must verify as already_used');
	assert(svc.tryClaim(r.payload) === false, 'consumed invite must not be re-claimable');
});

check('a claim held by a still-running create survives the sweep; it is freed only once the invite expired', () => {
	// v1.20.0 fix wave (D6): claims used to be swept 120 s after claiming,
	// while a create can legitimately still be broadcasting — freeing the
	// invite mid-flight let ONE invite create TWO accounts. The create endpoint
	// consumes or releases its claim on every path (try/finally); the sweep
	// only frees a claim once the invite itself has expired.
	const clock = new ManualClock('2026-08-21T00:00:00Z');
	const svc = new InviteTokenService({ secret: SECRET, ttlMs: 600_000, clock });
	const { token } = svc.issue(IP);
	const r = svc.verify(token, IP);
	assert(r.ok, 'verify ok');
	assert(svc.tryClaim(r.payload) === true, 'claim ok');
	clock.advance(121_000);
	(svc as unknown as { sweep(): void }).sweep();
	const midFlight = svc.verify(token, IP);
	assert(!midFlight.ok && midFlight.code === 'invite_already_used', 'claim must hold while the invite is still valid');
	clock.advance(600_000);
	(svc as unknown as { sweep(): void }).sweep();
	assert((svc as unknown as { claimedNonces: Map<string, number> }).claimedNonces.size === 0, 'expired invite claim swept');
	const expired = svc.verify(token, IP);
	assert(!expired.ok && expired.code === 'invite_expired', 'an expired invite stays unusable');
	svc.close();
});

console.log(
	`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} invite-claim TOCTOU scenarios passed`
);
process.exit(failures === 0 ? 0 : 1);
