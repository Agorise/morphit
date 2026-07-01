import { describe, expect, it, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';

import { InviteEndpoint } from '../src/api/invite.ts';
import { Limiter } from '../src/middleware/ratelimit.ts';
import { GlobalDailyCeiling } from '../src/policy/globalDailyCeiling.ts';
import { InviteTokenService } from '../src/policy/inviteToken.ts';
import { AltchaService, type AltchaSolution } from '../src/policy/altcha.ts';

/** Brute-force an Altcha challenge. Mirrors the browser widget. */
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
	throw new Error('altcha: no solution found');
}

interface InviteResponseBody {
	status?: string;
	code?: string;
	message?: string;
	invite_token?: string;
	expires_at?: string;
	challenge?: {
		algorithm: 'SHA-256';
		challenge: string;
		salt: string;
		signature: string;
		maxnumber: number;
	};
	resets_at?: string;
}

describe('POST /v1/account/invite', () => {
	const resources: Array<{ close: () => void }> = [];
	afterEach(() => {
		for (const r of resources) r.close();
		resources.length = 0;
	});

	function makeApp(
		opts: {
			signupEnabled?: boolean;
			dailyCeiling?: number;
			invitesPerHour?: number;
			altchaTriggerCount?: number;
			altchaMaxnumber?: number;
		} = {}
	) {
		const ceiling = new GlobalDailyCeiling(opts.dailyCeiling ?? 10_000);
		const inviteLimiter = new Limiter(opts.invitesPerHour ?? 1000, 60 * 60_000);
		resources.push(inviteLimiter);
		const altcha = new AltchaService({
			maxnumber: opts.altchaMaxnumber ?? 1000
		});
		resources.push(altcha);
		const inviteTokens = new InviteTokenService({ ttlMs: 10 * 60_000 });
		resources.push(inviteTokens);

		const endpoint = new InviteEndpoint(
			opts.signupEnabled ?? true,
			ceiling,
			inviteLimiter,
			opts.altchaTriggerCount ?? 3,
			altcha,
			inviteTokens
		);
		const app = new Hono();
		endpoint.register(app);
		return { app, ceiling, inviteLimiter, altcha, inviteTokens };
	}

	async function post(
		app: Hono,
		body: Record<string, unknown> = {}
	): Promise<{ status: number; body: InviteResponseBody }> {
		const res = await app.request('/v1/account/invite', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const json = (await res.json().catch(() => ({}))) as InviteResponseBody;
		return { status: res.status, body: json };
	}

	it('happy path: returns status=issued with a token and ISO expires_at', async () => {
		const { app } = makeApp();
		const { status, body } = await post(app);
		expect(status).toBe(200);
		expect(body.status).toBe('issued');
		expect(body.invite_token).toBeTruthy();
		expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('kill-switch: signupEnabled=false → 503 signups_disabled', async () => {
		const { app } = makeApp({ signupEnabled: false });
		const { status, body } = await post(app);
		expect(status).toBe(503);
		expect(body.code).toBe('signups_disabled');
	});

	it('ceiling pre-check: ceiling hit → 503 daily_ceiling_reached with resets_at', async () => {
		const { app, ceiling } = makeApp({ dailyCeiling: 1 });
		// Burn the ceiling manually (simulating a successful signup
		// earlier in the day).
		ceiling.recordSuccess();

		const { status, body } = await post(app);
		expect(status).toBe(503);
		expect(body.code).toBe('daily_ceiling_reached');
		expect(body.resets_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('per-IP rate limit: second invite after limit exhausted → 429', async () => {
		const { app } = makeApp({ invitesPerHour: 1 });

		const first = await post(app);
		expect(first.status).toBe(200);

		const second = await post(app);
		expect(second.status).toBe(429);
		expect(second.body.code).toBe('invite_rate_limited');
	});

	it('altcha trigger: Nth invite returns altcha_required', async () => {
		// altchaTriggerCount=2 means the 2nd invite needs altcha.
		const { app } = makeApp({ altchaTriggerCount: 2 });

		const first = await post(app);
		expect(first.status).toBe(200);
		expect(first.body.status).toBe('issued');

		const second = await post(app);
		expect(second.status).toBe(200);
		expect(second.body.status).toBe('altcha_required');
		expect(second.body.challenge).toBeTruthy();
		expect(second.body.challenge?.algorithm).toBe('SHA-256');
	});

	it('altcha pass: submitting a valid solution on the triggered invite → issued', async () => {
		const { app } = makeApp({ altchaTriggerCount: 2 });
		// Get to the altcha trigger.
		await post(app);

		// Ask for the challenge.
		const challengeResp = await post(app);
		expect(challengeResp.body.status).toBe('altcha_required');
		const c = challengeResp.body.challenge!;
		const sol = solve(c);

		// Submit the solution — should now issue a token.
		const solved = await post(app, { altcha_solution: sol });
		expect(solved.status).toBe(200);
		expect(solved.body.status).toBe('issued');
		expect(solved.body.invite_token).toBeTruthy();
	});

	it('altcha fail: invalid solution → 400 with fresh challenge attached', async () => {
		const { app } = makeApp({ altchaTriggerCount: 2 });
		await post(app);

		// Get a challenge, then send a deliberately-wrong solution.
		const ch = await post(app);
		const c = ch.body.challenge!;
		const sol = solve(c);
		const bad = { ...sol, number: sol.number + 1 };

		const resp = await post(app, { altcha_solution: bad });
		expect(resp.status).toBe(400);
		expect(resp.body.code).toBe('altcha_bad_solution');
		// Fresh challenge included so the client can retry.
		expect(resp.body.challenge).toBeTruthy();
	});

	// Regression test for the audit-2026-05 race fix.  Pre-fix, the
	// invite handler awaited body parsing BEFORE reading priorToday,
	// so concurrent requests from the same IP saw priorToday=0 and
	// all bypassed the altcha gate.  Post-fix, priorToday is read
	// AND tentatively reserved synchronously between the rate-limit
	// check and the body-parse await, so concurrent requests
	// interleave correctly: the third concurrent request sees
	// priorToday=2 with altchaTriggerCount=3 and IS gated.
	it('race: concurrent invites correctly gate altcha at the trigger', async () => {
		const { app } = makeApp({
			altchaTriggerCount: 3,
			invitesPerHour: 100 // high so rate-limit doesn't gate first
		});
		// Fire 5 invites concurrently from the same IP.  Two should
		// succeed without altcha (priorToday=0 and priorToday=1);
		// three should require altcha (priorToday=2, 3, 4).
		const responses = await Promise.all([post(app), post(app), post(app), post(app), post(app)]);

		const issued = responses.filter((r) => r.body.status === 'issued');
		const altchaRequired = responses.filter((r) => r.body.status === 'altcha_required');

		expect(issued.length).toBe(2);
		expect(altchaRequired.length).toBe(3);
	});
});
