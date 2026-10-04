/**
 * The relay must not POST a Web Push to an arbitrary URL.
 *
 * A subscription's endpoint is a URL the browser hands us; the relay later
 * POSTs to it from its own address on every notification. Any URL used to
 * pass, so a signed-in user could point it at the relay's loopback or LAN (a
 * blind SSRF / port probe). Now: https browser push services only (plus
 * operator-added hosts), refused at subscribe AND re-checked at send, and the
 * connection only ever goes to a public address.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { Hono } from 'hono';
import webpush from 'web-push';
import { PushEndpoints } from '../src/api/push.ts';
import { PushSender } from '../src/policy/pushSender.ts';
import { Limiter } from '../src/middleware/ratelimit.ts';
import type { PushSubscriptionStore } from '../src/policy/pushSubscriptions.ts';
import type { BlurtClient } from '../src/blurt/client.ts';
import type { Config } from '../src/config/index.ts';
import { publicOnlyLookup } from '../src/policy/pushEndpoint.ts';

function app(stored: unknown[]): Hono {
	const store = {
		upsert: async (input: unknown) => {
			stored.push(input);
			return { createdAt: new Date(), privacyMode: 'standard' };
		}
	} as unknown as PushSubscriptionStore;
	const a = new Hono();
	new PushEndpoints(
		true,
		'vapid-public',
		new Limiter(1000, 60_000),
		new Limiter(1000, 60_000),
		store,
		{} as BlurtClient,
		false,
		false
	).register(a);
	return a;
}

async function subscribe(a: Hono, endpoint: string): Promise<number> {
	const res = await a.request('/v1/push/subscribe', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			account: 'alice',
			subscription: { endpoint, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } },
			privacy_mode: 'standard'
		})
	});
	return res.status;
}

describe('push subscribe: endpoint policy', () => {
	it.each([
		'https://10.0.0.5/x',
		'http://127.0.0.1:1/',
		'https://127.0.0.1/push',
		'https://[::1]/push',
		'https://evil.example/fcm/send/abc',
		'http://fcm.googleapis.com/fcm/send/abc',
		'https://fcm.googleapis.com:8443/fcm/send/abc',
		'https://user:pw@fcm.googleapis.com/fcm/send/abc',
		'https://fcm.googleapis.com.evil.example/x'
	])('refuses %s and stores nothing', async (endpoint) => {
		const stored: unknown[] = [];
		expect(await subscribe(app(stored), endpoint)).toBe(400);
		expect(stored).toHaveLength(0);
	});

	it.each([
		'https://fcm.googleapis.com/fcm/send/abc',
		'https://updates.push.services.mozilla.com/wpush/v2/abc',
		'https://wns2-bl2p.notify.windows.com/w/?token=abc',
		'https://web.push.apple.com/QGRv'
	])('accepts the browser push service %s', async (endpoint) => {
		const stored: unknown[] = [];
		expect(await subscribe(app(stored), endpoint)).toBe(200);
		expect(stored).toHaveLength(1);
	});
});

describe('push send: a stored off-policy endpoint is never contacted', () => {
	let server: net.Server;
	let port = 0;
	let connections = 0;
	beforeAll(async () => {
		server = net.createServer((s) => {
			connections++;
			s.destroy();
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		port = (server.address() as net.AddressInfo).port;
	});
	afterAll(async () => {
		await new Promise<void>((r) => server.close(() => r()));
	});

	it('a row from before this check pointing at loopback is dropped, not sent', async () => {
		const keys = webpush.generateVAPIDKeys();
		const sender = new PushSender(
			{
				pushEnabled: true,
				vapidSubject: 'mailto:ops@example.com',
				vapidPublicKey: keys.publicKey,
				vapidPrivateKey: keys.privateKey
			} as unknown as Config,
			{} as never,
			{} as never
		);
		const sub = webpush.generateVAPIDKeys(); // any valid P-256 point for p256dh
		const outcome = await (
			sender as unknown as { sendOne: (d: unknown, p: string) => Promise<string> }
		).sendOne(
			{
				account: 'alice',
				endpoint: `https://127.0.0.1:${port}/push`,
				p256dh: sub.publicKey,
				auth: 'a'.repeat(22)
			},
			'{}'
		);
		expect(outcome).toBe('gone');
		expect(connections).toBe(0);
	});
});

describe('push send: the name must resolve to public addresses only', () => {
	const run = (answers: string[]) =>
		new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
			const lookup = publicOnlyLookup((_h, cb) =>
				cb(
					null,
					answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
				)
			);
			lookup('fcm.googleapis.com', {}, (err, address) => resolve({ err, address }));
		});

	it.each([[['127.0.0.1']], [['10.1.2.3']], [['142.250.1.1', '169.254.169.254']], [['::1']], [[]]])(
		'refuses %j',
		async (answers) => {
			const r = await run(answers);
			expect(r.err?.code).toBe('EPUSHPRIVATE');
		}
	);

	it('connects to the public address it checked', async () => {
		const r = await run(['142.250.1.1']);
		expect(r.err).toBeNull();
		expect(r.address).toBe('142.250.1.1');
	});
});
