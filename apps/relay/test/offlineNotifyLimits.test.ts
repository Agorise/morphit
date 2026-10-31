/**
 * Offline notices — the request limits, seen from one shared IP (every Tor
 * visitor of a hidden site reaches the relay from the same address):
 *
 *   - junk from that IP must not lock everyone out of taking an address back;
 *   - ordinary use (a heartbeat a minute from every user online) must never
 *     fill it;
 *   - failures still count, and once spent, nothing new is looked up on the
 *     chain for that IP;
 *   - the per-account limit holds, but never for "remove" or "cancel".
 *
 * Plus the guards around them: a heartbeat only counts for an account with an
 * address on; a channel the site does not offer is refused; with the store
 * unavailable no channel is listed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { PrivateKey } from '@beblurt/dblurt';
import { Limiter } from '../src/middleware/ratelimit.ts';
import {
	MAX_REMEMBERED,
	MAX_REMEMBERED_PER_ACCOUNT,
	MAX_KEYS,
	NotifySigVerifier,
	notifyCanonical,
	notifyPayload,
	type NotifyAction
} from '../src/notify/sig.ts';
import { OfflineNotifyEndpoints, type NotifyLimits } from '../src/notify/api.ts';
import { ManualClock } from '../src/policy/clock.ts';
import { Presence } from '../src/notify/worker.ts';

const AUDIENCE = 'relay-test';
const keys = new Map<string, PrivateKey>();
const keyOf = (a: string): PrivateKey => {
	let k = keys.get(a);
	if (!k) {
		k = PrivateKey.fromSeed(`limits-${a}`);
		keys.set(a, k);
	}
	return k;
};

const T0 = Date.parse('2026-10-15T12:00:00Z');

function setup(
	opts: {
		perIp?: number;
		perAccount?: number;
		takeBack?: number;
		spentPerSec?: number;
		store?: boolean;
		send?: boolean;
		/** The database is too busy to answer in time (a lock wait ran out). */
		busy?: boolean;
	} = {}
) {
	const clock = new ManualClock(T0);
	const lookups: string[] = [];
	const chain = {
		async postingKeyAgreed(name: string) {
			lookups.push(name);
			return name.startsWith('ghost')
				? { key: null }
				: { key: keyOf(name).createPublic('BLT').toString() };
		}
	};
	const calls = { remove: 0, cancel: 0, begin: 0, open: 0, answerAt: [] as number[] };
	const verified = new Set<string>(['alice']);
	const store = {
		async remove() {
			calls.remove++;
			if (opts.busy)
				throw Object.assign(new Error('canceling statement due to lock timeout'), {
					code: '55P03'
				});
		},
		async restoreOrDrop() {
			calls.cancel++;
		},
		async hasVerified(a: string) {
			return verified.has(a);
		},
		async status() {
			return { channels: [], locale: null };
		},
		async beginAddress() {
			calls.begin++;
			return { ok: true, codeMac: Buffer.alloc(32), send: opts.send ?? false };
		},
		async resolveLink() {
			calls.open++;
			return { peer: 'bob', orderPermlink: '' };
		},
		async claimLeaves() {
			return [];
		}
	};
	const cfg = {
		siteName: 'Test',
		audience: AUDIENCE,
		linkOrigin: 'http://example.onion',
		linkOrigins: {},
		policy: { torSocks: '', hiddenOnly: true },
		email: {
			host: 'mail.example.onion',
			port: 25,
			security: 'starttls',
			user: 'u',
			password: 'p',
			from: 'site@example.onion'
		},
		matrix: null,
		xmpp: null,
		telegram: null,
		session: null,
		off: {}
	};
	const presence = new Presence(() => clock.now());
	const sig = new NotifySigVerifier(chain, AUDIENCE, () => clock.now());
	const limits: NotifyLimits = {
		ip: new Limiter(opts.perIp ?? 300, 10 * 60_000, clock),
		spent: new Limiter(opts.spentPerSec ?? 20, 1_000, clock),
		here: new Limiter(4, 60_000, clock),
		takeBack: new Limiter(opts.takeBack ?? 60, 10 * 60_000, clock),
		account: new Limiter(opts.perAccount ?? 30, 10 * 60_000, clock)
	};
	const app = new Hono();
	new OfflineNotifyEndpoints(
		cfg as never,
		opts.store === false ? null : (store as never),
		sig,
		presence,
		limits,
		{
			now: () => new Date(clock.now()),
			codeAnswerMs: 45_000,
			waitUntil: async (at) => {
				calls.answerAt.push(at);
			}
		}
	).register(app);
	const request = async (
		action: NotifyAction,
		account: string,
		fields: Record<string, unknown> = {},
		signer: string = account
	) => {
		const timestamp = Math.floor(clock.now() / 1000);
		const nonce = randomBytes(16).toString('hex');
		const digest = createHash('sha256')
			.update(
				notifyCanonical(action, AUDIENCE, account, nonce, notifyPayload(action, fields), timestamp),
				'utf8'
			)
			.digest();
		const body = {
			...fields,
			account,
			nonce,
			timestamp,
			signature: keyOf(signer).sign(digest).toString()
		};
		const r = await app.request(`/v1/notify/${action}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		return { status: r.status, body: (await r.json()) as Record<string, unknown> };
	};
	const post = (action: NotifyAction, account: string, fields: Record<string, unknown> = {}) =>
		request(action, account, fields);
	/** Requests that cost the relay something: a chain lookup each (made-up names). */
	const flood = async (n: number) => {
		for (let i = 0; i < n; i++) await post('here', `ghost${i}`);
	};
	/** Requests that cost nothing to refuse. */
	const junk = async (n: number) => {
		for (let i = 0; i < n; i++)
			await app.request('/v1/notify/here', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: i % 2 ? '{}' : 'not json'
			});
	};
	return { app, clock, sig, post, request, flood, junk, calls, lookups, presence, verified };
}

describe('offline notices: limits on one shared IP', () => {
	it('after a flood, she can still delete her addresses — even half an hour later', async () => {
		const t = setup({ perIp: 20 });
		// She has the site open: her heartbeat made her key known.
		expect((await t.post('here', 'alice')).status).toBe(200);
		await t.flood(50);
		t.clock.advance(30 * 60_000);
		await t.flood(50);
		const before = t.lookups.length;
		expect(await t.post('remove', 'alice', { channel: 'all' })).toEqual({
			status: 200,
			body: { status: 'removed' }
		});
		expect(t.calls.remove).toBe(1);
		t.clock.advance(1_000);
		expect((await t.post('cancel', 'alice', { channel: 'email' })).status).toBe(200);
		expect(t.calls.cancel).toBe(1);
		// …and her heartbeat keeps working.
		expect((await t.post('here', 'alice')).status).toBe(200);
		// Her (stale) key was checked without a lookup, then refreshed once.
		expect(t.lookups.slice(before).filter((n) => n === 'alice').length).toBeLessThanOrEqual(1);
	});

	it('once its failures are spent, nothing new is looked up on the chain for that IP', async () => {
		const t = setup({ perIp: 20 });
		await t.flood(20);
		const before = t.lookups.length;
		const r = await t.post('status', 'newcomer');
		expect(r).toEqual({ status: 429, body: { status: 'rate_limited' } });
		expect(t.lookups.length).toBe(before);
	});

	it('requests that cost nothing to refuse never use up the IP', async () => {
		const t = setup({ perIp: 5 });
		await t.junk(500);
		// Out-of-date and malformed signatures cost nothing either.
		for (let i = 0; i < 50; i++)
			await t.app.request('/v1/notify/status', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					account: 'alice',
					nonce: 'a'.repeat(32),
					timestamp: Math.floor(t.clock.now() / 1000) - 3600,
					signature: 'x'.repeat(60)
				})
			});
		expect((await t.post('status', 'newcomer')).status).toBe(200);
	});

	it('bad signatures count as failures too', async () => {
		const t = setup({ perIp: 5 });
		await t.post('status', 'alice');
		for (let i = 0; i < 5; i++)
			expect((await t.request('status', 'alice', {}, 'mallory')).status).toBe(401);
		const before = t.lookups.length;
		expect((await t.post('status', 'newcomer')).status).toBe(429);
		expect(t.lookups.length).toBe(before);
	});

	it('from a spent IP, the work is bounded: a small shared budget per second', async () => {
		const t = setup({ perIp: 5, spentPerSec: 3 });
		await t.post('here', 'alice');
		await t.flood(5);
		// Bad signatures naming alice (known key): only 3 a second are checked.
		const codes: number[] = [];
		for (let i = 0; i < 10; i++)
			codes.push((await t.request('status', 'alice', {}, 'mallory')).status);
		expect(codes.filter((c) => c === 401)).toHaveLength(3);
		expect(codes.filter((c) => c === 429)).toHaveLength(7);
		t.clock.advance(1_001);
		expect((await t.post('remove', 'alice', { channel: 'all' })).status).toBe(200);
	});

	it('ordinary use never fills it: a heartbeat from each of many users, for many minutes', async () => {
		const t = setup({ perIp: 20 });
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 40; i++) {
				const r = await t.post('here', `user${i}`);
				expect(r.status, `round ${round} user ${i}`).toBe(200);
			}
			t.clock.advance(60_000);
		}
		for (let i = 0; i < 30; i++)
			expect(
				(
					await t.post('set', `user${i}`, {
						channel: 'email',
						address: `u${i}@example.onion`,
						locale: 'en'
					})
				).status
			).toBe(200);
	});

	it('per account: the general limit, and a generous one of its own for taking an address back', async () => {
		const t = setup({ perAccount: 3, takeBack: 5 });
		for (let i = 0; i < 3; i++) expect((await t.post('status', 'alice')).status).toBe(200);
		expect((await t.post('status', 'alice')).status).toBe(429);
		// Remove and cancel are not held back by the general limit…
		for (let i = 0; i < 5; i++)
			expect(
				(await t.post(i % 2 ? 'cancel' : 'remove', 'alice', { channel: 'email' })).status
			).toBe(200);
		// …but have their own.
		expect((await t.post('remove', 'alice', { channel: 'all' })).status).toBe(429);
		// Another account is not affected.
		expect((await t.post('status', 'bob')).status).toBe(200);
	});

	it('a refused request takes no room in the replay memory: one account cannot lock out the rest', async () => {
		const t = setup();
		// mallory sends far more heartbeats than her limit allows.
		const seen: Record<number, number> = {};
		for (let i = 0; i < 2_000; i++) {
			const s = (await t.post('here', 'mallory')).status;
			seen[s] = (seen[s] ?? 0) + 1;
		}
		expect(seen[429]).toBeGreaterThan(1_900);
		expect((await t.post('remove', 'alice', { channel: 'all' })).status).toBe(200);
		expect((await t.post('status', 'bob')).status).toBe(200);
	});

	it('the same request twice: the second is refused, and does not use up her limit', async () => {
		const t = setup({ perAccount: 2 });
		const timestamp = Math.floor(t.clock.now() / 1000);
		const nonce = randomBytes(16).toString('hex');
		const digest = createHash('sha256')
			.update(notifyCanonical('status', AUDIENCE, 'alice', nonce, '', timestamp), 'utf8')
			.digest();
		const body = JSON.stringify({
			account: 'alice',
			nonce,
			timestamp,
			signature: keyOf('alice').sign(digest).toString()
		});
		const send = () =>
			t.app.request('/v1/notify/status', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body
			});
		expect((await send()).status).toBe(200);
		for (let i = 0; i < 5; i++) expect((await send()).status).toBe(401);
		// One more of her own requests still fits her limit of two.
		expect((await t.post('status', 'alice')).status).toBe(200);
	});
});

describe('offline notices: the replay memory and the key cache', () => {
	const signed = (account: string, nowMs: number, signer = account) => {
		const timestamp = Math.floor(nowMs / 1000);
		const nonce = randomBytes(16).toString('hex');
		const digest = createHash('sha256')
			.update(notifyCanonical('status', AUDIENCE, account, nonce, '', timestamp), 'utf8')
			.digest();
		return {
			action: 'status' as const,
			account,
			nonce,
			payload: '',
			timestamp,
			signature: keyOf(signer).sign(digest).toString()
		};
	};
	const chain = {
		lookups: 0,
		async postingKeyAgreed(name: string) {
			this.lookups++;
			return { key: keyOf(name).createPublic('BLT').toString() };
		}
	};

	it('a full memory per account refuses only that account; a full memory refuses rather than forgets', () => {
		const v = new NotifySigVerifier(chain, AUDIENCE, () => T0);
		const ts = Math.floor(T0 / 1000);
		for (let i = 0; i < MAX_REMEMBERED_PER_ACCOUNT; i++)
			expect(v.commit('mallory', `n${i}`, ts)).toBe(true);
		expect(v.commit('mallory', 'one-more', ts)).toBe(false);
		expect(v.commit('alice', 'first', ts)).toBe(true);
		// Fill it up across many accounts: then a new request is refused…
		let k = 0;
		for (let a = 0; k < MAX_REMEMBERED - MAX_REMEMBERED_PER_ACCOUNT - 1; a++)
			for (
				let i = 0;
				i < MAX_REMEMBERED_PER_ACCOUNT && k < MAX_REMEMBERED - MAX_REMEMBERED_PER_ACCOUNT - 1;
				i++, k++
			)
				v.commit(`acct${a}`, `n${i}`, ts);
		expect(v.commit('carol', 'x', ts)).toBe(false);
		// …and nothing remembered was forgotten to make room.
		expect(v.commit('mallory', 'n0', ts)).toBe(false);
		expect(v.commit('alice', 'first', ts)).toBe(false);
	});

	it('a request is remembered until it could no longer pass the clock check, not a moment less', () => {
		let now = T0;
		const v = new NotifySigVerifier(chain, AUDIENCE, () => now);
		const ts = Math.floor(T0 / 1000);
		expect(v.commit('alice', 'n', ts)).toBe(true);
		now += 5 * 60_000;
		expect(v.commit('alice', 'n', ts)).toBe(false);
		now += 2_000;
		expect(v.commit('alice', 'n', ts)).toBe(true);
	});

	it('a bad signature with her nonce does not spoil her real request', async () => {
		const v = new NotifySigVerifier(chain, AUDIENCE, () => T0);
		const real = signed('alice', T0);
		const forged = { ...real, signature: signed('alice', T0, 'mallory').signature };
		expect((await v.verify(forged)).ok).toBe(false);
		expect(await v.verify(real)).toEqual({ ok: true });
	});

	it('the key cache is bounded, and keeps the accounts in use', async () => {
		const now = T0;
		const KEYS = 100;
		const fake = {
			async postingKeyAgreed(name: string) {
				return {
					key: name.startsWith('ghost') ? null : keyOf(name).createPublic('BLT').toString()
				};
			}
		};
		const v = new NotifySigVerifier(fake, AUDIENCE, () => now, KEYS);
		const size = () => (v as unknown as { keys: Map<string, unknown> }).keys.size;
		expect(await v.verify(signed('alice', now))).toEqual({ ok: true });
		// Made-up names pour in while alice keeps using the site.
		for (let i = 0; i < 3 * KEYS; i++) {
			if (i % (KEYS / 2) === 0) expect(await v.verify(signed('alice', now))).toEqual({ ok: true });
			await v.check(signed(`ghost${i}`, now));
			expect(size()).toBeLessThanOrEqual(KEYS);
		}
		expect(v.knowsKey('alice')).toBe(true);
		expect(MAX_KEYS).toBeGreaterThanOrEqual(10_000);
	});
});

describe('offline notices: the guards around the requests', () => {
	it('a heartbeat only counts for an account with an address on', async () => {
		const t = setup();
		await t.post('here', 'alice');
		await t.post('here', 'bob');
		expect(t.presence.isHere('alice')).toBe(true);
		expect(t.presence.isHere('bob')).toBe(false);
	});

	it('every code request is answered at the same moment: sent, failed, or none sent at all', async () => {
		const quiet = setup({ send: false });
		const r = await quiet.post('set', 'alice', {
			channel: 'email',
			address: 'busy@example.onion',
			locale: 'en'
		});
		expect(r).toEqual({ status: 200, body: { status: 'code_sent' } });
		// The same request when a code is due goes to the mail server (here
		// refused at once: no Tor in the test) — answered at the same moment.
		const loud = setup({ send: true });
		const s = await loud.post('set', 'alice', {
			channel: 'email',
			address: 'free@example.onion',
			locale: 'en'
		});
		expect(s.body.status).toBe('send_failed');
		expect(quiet.calls.answerAt).toEqual([T0 + 45_000]);
		expect(loud.calls.answerAt).toEqual([T0 + 45_000]);
	});

	it('a forwarded notice link opens nothing for someone signing as her without her key', async () => {
		const t = setup();
		const token = 'A'.repeat(24);
		// mallory signs with her own key but names alice.
		const timestamp = Math.floor(Date.now() / 1000);
		const nonce = randomBytes(16).toString('hex');
		const digest = createHash('sha256')
			.update(
				notifyCanonical(
					'open',
					AUDIENCE,
					'alice',
					nonce,
					notifyPayload('open', { token }),
					timestamp
				),
				'utf8'
			)
			.digest();
		const r = await t.app.request('/v1/notify/open', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token,
				account: 'alice',
				nonce,
				timestamp,
				signature: keyOf('mallory').sign(digest).toString()
			})
		});
		expect(r.status).toBe(401);
		expect(t.calls.open).toBe(0);
		// Her own signature does open it.
		expect((await t.post('open', 'alice', { token })).body).toEqual({
			status: 'ok',
			peer: 'bob',
			order: null
		});
	});

	it('a channel this site does not offer is refused before anything is saved or sent', async () => {
		const t = setup();
		const r = await t.post('set', 'alice', {
			channel: 'matrix',
			address: '@a:hs.org',
			locale: 'en'
		});
		expect(r).toEqual({ status: 400, body: { status: 'channel_not_offered' } });
		expect(t.calls.begin).toBe(0);
	});

	it('with the store unavailable, no channel is listed and requests are refused', async () => {
		const t = setup({ store: false });
		const ch = (await (await t.app.request('/v1/notify/channels')).json()) as Record<
			string,
			unknown
		>;
		expect(ch.channels).toEqual([]);
		expect(ch.stored).toBe(false);
		expect((await t.post('status', 'alice')).status).toBe(503);
	});
});

describe('offline notices: the signature check over time', () => {
	const signFor = (
		k: PrivateKey,
		account: string,
		nowSec: number,
		action: NotifyAction = 'status'
	) => {
		const nonce = randomBytes(16).toString('hex');
		const digest = createHash('sha256')
			.update(notifyCanonical(action, AUDIENCE, account, nonce, '', nowSec), 'utf8')
			.digest();
		return {
			action,
			account,
			nonce,
			payload: '',
			timestamp: nowSec,
			signature: k.sign(digest).toString()
		};
	};

	it('a request signed more than five minutes ago (or ahead) is refused', async () => {
		const t = 1_800_000_000_000;
		const k = keyOf('alice');
		const v = new NotifySigVerifier(
			{ postingKeyAgreed: async () => ({ key: k.createPublic('BLT').toString() }) },
			AUDIENCE,
			() => t
		);
		const sec = Math.floor(t / 1000);
		expect(await v.verify(signFor(k, 'alice', sec - 299))).toEqual({ ok: true });
		expect(await v.verify(signFor(k, 'alice', sec - 301))).toEqual({
			ok: false,
			reason: 'timestamp_out_of_range'
		});
		expect(await v.verify(signFor(k, 'alice', sec + 301))).toEqual({
			ok: false,
			reason: 'timestamp_out_of_range'
		});
	});

	it('a key she rotated stops working within two minutes; "known key" lasts as long', async () => {
		let t = 1_800_000_000_000;
		const oldKey = PrivateKey.fromSeed('rotate-old');
		const newKey = PrivateKey.fromSeed('rotate-new');
		let onChain = oldKey;
		const v = new NotifySigVerifier(
			{ postingKeyAgreed: async () => ({ key: onChain.createPublic('BLT').toString() }) },
			AUDIENCE,
			() => t
		);
		expect(v.knowsKey('alice')).toBe(false);
		expect(await v.verify(signFor(oldKey, 'alice', Math.floor(t / 1000)))).toEqual({ ok: true });
		expect(v.knowsKey('alice')).toBe(true);
		onChain = newKey;
		t += 60_000;
		expect(v.knowsKey('alice')).toBe(true);
		t += 61_000;
		expect(v.knowsKey('alice')).toBe(false);
		expect(await v.verify(signFor(oldKey, 'alice', Math.floor(t / 1000)))).toEqual({
			ok: false,
			reason: 'signature_mismatch'
		});
		expect(await v.verify(signFor(newKey, 'alice', Math.floor(t / 1000)))).toEqual({ ok: true });
	});

	it('an account with no key on the chain is never "known"', async () => {
		const v = new NotifySigVerifier({ postingKeyAgreed: async () => ({ key: null }) }, AUDIENCE);
		const k = keyOf('ghost');
		expect((await v.verify(signFor(k, 'ghost', Math.floor(Date.now() / 1000)))).ok).toBe(false);
		expect(v.knowsKey('ghost')).toBe(false);
	});
});

describe('offline notices: a database too busy to answer in time', () => {
	it('is a 503 "busy" (the page says to try again in a moment), not an internal error', async () => {
		const t = setup({ busy: true });
		expect(await t.post('remove', 'alice', { channel: 'all' })).toEqual({
			status: 503,
			body: { status: 'busy' }
		});
	});
});
