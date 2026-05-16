/**
 * Availability endpoint test.
 *
 * Approach: construct a Hono app wired exactly like main.ts but with
 * a stub BlurtClient injected. We don't need a real chain — just a
 * spy that returns what the test expects.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

import { registerAvailabilityRoutes } from '../src/api/availability.ts';
import { Limiter } from '../src/middleware/ratelimit.ts';
import type { BlurtClient, AccountInfo } from '../src/blurt/client.ts';

interface AvailabilityResponse {
	name?: string;
	available?: boolean;
	reason?: string;
	status?: string;
	code?: string;
	message?: string;
}

interface StubBlurt {
	client: BlurtClient;
	getAccount: ReturnType<typeof vi.fn>;
}

function makeStubBlurt(accountResponse: AccountInfo | null | Error): StubBlurt {
	const getAccount = vi.fn(async () => {
		if (accountResponse instanceof Error) throw accountResponse;
		return accountResponse;
	});
	// Cast through unknown: we only exercise getAccount() in these tests.
	const client = { getAccount } as unknown as BlurtClient;
	return { client, getAccount };
}

function makeApp(stub: StubBlurt, maxPerMin = 1000): { app: Hono; limiter: Limiter } {
	const app = new Hono();
	const limiter = new Limiter(maxPerMin, 60_000);
	registerAvailabilityRoutes(app, stub.client, limiter);
	return { app, limiter };
}

async function post(
	app: Hono,
	body: unknown
): Promise<{ status: number; body: AvailabilityResponse }> {
	const res = await app.request('/v1/account/availability', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
	const json = (await res.json().catch(() => ({}))) as AvailabilityResponse;
	return { status: res.status, body: json };
}

describe('POST /v1/account/availability', () => {
	let limiters: Limiter[] = [];

	beforeEach(() => {
		limiters = [];
	});

	afterEach(() => {
		for (const l of limiters) l.close();
	});

	it('returns available=true when the name passes structural + chain check', async () => {
		const stub = makeStubBlurt(null); // name not found on-chain
		const { app, limiter } = makeApp(stub);
		limiters.push(limiter);

		const { status, body } = await post(app, { name: 'sally' });
		expect(status).toBe(200);
		expect(body.available).toBe(true);
		expect(body.name).toBe('sally');
		expect(body.reason).toBeUndefined();
		expect(stub.getAccount).toHaveBeenCalledWith('sally');
	});

	it('returns available=false with reason=already_registered when on-chain', async () => {
		const stub = makeStubBlurt({
			name: 'taken',
			created: '2024-01-01T00:00:00',
			balance: '0.000 BLURT',
			pending_claimed_accounts: 0,
			posting_pubkey: undefined
		});
		const { app, limiter } = makeApp(stub);
		limiters.push(limiter);

		const { body } = await post(app, { name: 'taken' });
		expect(body.available).toBe(false);
		expect(body.reason).toBe('already_registered');
	});

	it('rejects structurally-invalid names WITHOUT calling the chain', async () => {
		const stub = makeStubBlurt(null);
		const { app, limiter } = makeApp(stub);
		limiters.push(limiter);

		const cases: Array<[string, string]> = [
			['ab', 'too_short'],
			['abcdefghijklmnopq', 'too_long'],
			['3sally', 'must_start_with_letter'],
			['sally-', 'leading_trailing_dash'],
			['sa--lly', 'consecutive_dashes'],
			['sally.x', 'dotted_not_allowed'],
			['sal ly', 'bad_chars'],
			['morphit', 'reserved']
		];
		for (const [name, expectedReason] of cases) {
			const { body } = await post(app, { name });
			expect(body.available, `for ${name}`).toBe(false);
			expect(body.reason, `for ${name}`).toBe(expectedReason);
		}
		expect(stub.getAccount).not.toHaveBeenCalled();
	});

	it('normalizes to lowercase + trims before validation', async () => {
		const stub = makeStubBlurt(null);
		const { app, limiter } = makeApp(stub);
		limiters.push(limiter);

		const { body } = await post(app, { name: '  SALLY  ' });
		expect(body.name).toBe('sally');
		expect(body.available).toBe(true);
		expect(stub.getAccount).toHaveBeenCalledWith('sally');
	});

	it('returns 503 chain_unavailable when the chain throws', async () => {
		const stub = makeStubBlurt(new Error('ECONNREFUSED'));
		const { app, limiter } = makeApp(stub);
		limiters.push(limiter);

		const { status, body } = await post(app, { name: 'sally' });
		expect(status).toBe(503);
		expect(body.code).toBe('chain_unavailable');
	});

	it('rejects malformed JSON with 400 malformed_request', async () => {
		const stub = makeStubBlurt(null);
		const { app, limiter } = makeApp(stub);
		limiters.push(limiter);

		const { status, body } = await post(app, 'not json');
		expect(status).toBe(400);
		expect(body.code).toBe('malformed_request');
	});

	it('rejects unknown fields in the body', async () => {
		const stub = makeStubBlurt(null);
		const { app, limiter } = makeApp(stub);
		limiters.push(limiter);

		const { status, body } = await post(app, { name: 'sally', extra: 'nope' });
		expect(status).toBe(400);
		expect(body.code).toBe('malformed_request');
	});

	it('rate-limits after the bucket fills', async () => {
		const stub = makeStubBlurt(null);
		const { app, limiter } = makeApp(stub, 2);
		limiters.push(limiter);

		await post(app, { name: 'one' });
		await post(app, { name: 'two' });
		const { status, body } = await post(app, { name: 'three' });
		expect(status).toBe(429);
		expect(body.code).toBe('rate_limited');
	});
});
