/**
 * QR sign-in cannot be switched off by one client.
 *
 * /v1/login-pairing/:pid/wait had no rate limit and no stream cap, an entry
 * outlived its client by five minutes, and /deliver parked a bundle for any
 * pid. One client filled the 10,000-entry registry in under a second and every
 * real desktop and phone got 503 "pairing registry at capacity". Wired here
 * exactly as main.ts wires it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';

import { loginPairingRoute, PairingRegistry } from '$api/loginPairing';
import {
	rateLimit,
	_resetRateLimitForTest,
	configureTrustedProxies
} from '$api/middleware/ratelimit';
import { _resetStreamCapsForTest, openStreamCount } from '$api/streamCaps';

const LIST = 120;
const RESOURCE = 600;

function wire(registry: PairingRegistry): Hono {
	const app = new Hono();
	const loginPairingApp = new Hono();
	loginPairingApp.use('/:pid/deliver', rateLimit('resource', RESOURCE));
	loginPairingApp.use('/:pid/wait', rateLimit('list', LIST));
	loginPairingApp.route('/', loginPairingRoute(registry));
	app.route('/v1/login-pairing', loginPairingApp);
	return app;
}

const env = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });
const pid = (): string => randomBytes(32).toString('hex');

describe('login pairing under a flood', () => {
	let registry: PairingRegistry;
	let app: Hono;
	const open: AbortController[] = [];

	beforeEach(() => {
		_resetRateLimitForTest();
		_resetStreamCapsForTest();
		configureTrustedProxies(undefined);
		registry = new PairingRegistry();
		app = wire(registry);
	});
	afterEach(() => {
		for (const a of open.splice(0)) a.abort();
		registry.close();
	});

	async function wait(p: string, ip: string): Promise<Response> {
		const ctrl = new AbortController();
		open.push(ctrl);
		return app.request(`/v1/login-pairing/${p}/wait`, { signal: ctrl.signal }, env(ip));
	}

	it('one client opening thousands of waits cannot lock a real desktop and phone out', async () => {
		let accepted = 0;
		for (let i = 0; i < 2_000; i++) {
			const r = await wait(pid(), '198.51.100.7');
			if (r.status === 200) accepted++;
		}
		expect(accepted, 'the attacker is held to its own stream allowance').toBeLessThanOrEqual(24);
		expect(registry.size()).toBeLessThanOrEqual(24);

		// Junk deliveries for pids nobody waits on park nothing.
		for (let i = 0; i < 200; i++) {
			const p = pid();
			const r = await app.request(
				`/v1/login-pairing/${p}/deliver`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ pid: p })
				},
				env('198.51.100.7')
			);
			expect(r.status).toBe(404);
		}
		expect(registry.size()).toBeLessThanOrEqual(24);

		// The victim: a desktop waits, a phone delivers, the desktop gets the bundle.
		const victim = pid();
		const desk = await wait(victim, '203.0.113.20');
		expect(desk.status).toBe(200);
		const phone = await app.request(
			`/v1/login-pairing/${victim}/deliver`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pid: victim, v: 1 })
			},
			env('203.0.113.21')
		);
		expect(phone.status).toBe(200);
		const text = await desk.text();
		expect(text).toContain('event: bundle');
		expect(text).toContain(victim);
	});

	it('a desktop that leaves takes its entry and its stream slot with it', async () => {
		const before = openStreamCount();
		const ctrl = new AbortController();
		const p = pid();
		const r = await app.request(
			`/v1/login-pairing/${p}/wait`,
			{ signal: ctrl.signal },
			env('203.0.113.30')
		);
		expect(r.status).toBe(200);
		const reader = r.body!.getReader();
		void reader.read().catch(() => undefined);
		await vi.waitFor(() => {
			expect(registry.size()).toBe(1);
			expect(openStreamCount()).toBe(before + 1);
		});
		ctrl.abort();
		await reader.cancel().catch(() => undefined);
		// Gone as soon as the client is (the bug kept it five minutes).
		await vi.waitFor(
			() => {
				expect(registry.size(), 'the entry outlived its client').toBe(0);
				expect(openStreamCount(), 'the stream slot was never given back').toBe(before);
			},
			{ timeout: 2000, interval: 5 }
		);
		// ...so the same desktop can wait again on the same code.
		const again = await wait(p, '203.0.113.30');
		expect(again.status).toBe(200);
	});
});
