/**
 * Settings → Offline Notifications: what the browser signs is what the relay
 * verifies.
 *
 * The two sides each build the signed string — the browser in
 * offlineNotify.ts, the relay in apps/relay/src/notify/sig.ts — and a single
 * stray byte between them (a field order, a missing default, a newline) would
 * make every request fail with "signature mismatch" in production while each
 * side's own tests stayed green. So this drives the browser's REAL request
 * functions, captures the exact bodies they send, and hands each one to the
 * relay's REAL verifier, with the posting key the browser signed with on the
 * stand-in chain. Every action has to pass, once; a body changed in transit,
 * a second use of the same signature, and a signature made for another site
 * (another audience) have to fail.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PrivateKey } from '@beblurt/dblurt';
import { writable } from 'svelte/store';
import {
	NotifySigVerifier,
	notifyPayload as relayPayload,
	type NotifyAction
} from '../../../../relay/src/notify/sig';

const ACCOUNT = 'grandma';
const key = PrivateKey.fromSeed('offline-notify-relay-parity');
const AUDIENCE = 'vigilante-relay';
const sent: Array<{ action: NotifyAction; body: Record<string, unknown> }> = [];

vi.mock('$net/config', () => ({
	MORPHIT_RELAY_ORIGIN: 'https://relay.test',
	resolveOrigin: (o: string) => o
}));
vi.mock('$lib/blurt/ops/profile', () => ({ getUserBlurtAccount: () => ACCOUNT }));
vi.mock('$lib/stores/identity', () => ({
	liveIdentity: writable({
		posting: { privateKey: Uint8Array.from((key as unknown as { key: Buffer }).key) }
	})
}));
vi.mock('$net/fetchWithTimeout', () => ({
	fetchWithTimeout: async (url: string, init: { body?: string }) => {
		if (url.endsWith('/channels'))
			return new Response(
				JSON.stringify({ site: 'Vigilante Trading', audience: AUDIENCE, channels: [] }),
				{ status: 200 }
			);
		const action = url.split('/').pop() as NotifyAction;
		sent.push({ action, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
		// Whatever each caller needs to return without throwing.
		const answer: Record<string, unknown> =
			action === 'set'
				? (JSON.parse(init.body ?? '{}') as { channel: string }).channel === 'telegram'
					? { status: 'telegram_code', code: '12345678', bot: 'Bot' }
					: { status: 'code_sent' }
				: action === 'verify'
					? { status: 'verified' }
					: action === 'open'
						? { peer: 'trader-joe', order: null }
						: { channels: [] };
		return new Response(JSON.stringify(answer), { status: 200 });
	}
}));

const web = await import('./offlineNotify');

describe('offline notices: browser signature ↔ relay verifier', () => {
	const chain = {
		postingKeyAgreed: async (name: string) =>
			name === ACCOUNT ? { key: key.createPublic('BLT').toString() } : { key: null }
	};
	const verifierFor = (audience: string) => new NotifySigVerifier(chain, audience);
	let verifier = verifierFor(AUDIENCE);
	const check = (s: (typeof sent)[number], v: NotifySigVerifier = verifier) => {
		const { account, nonce, timestamp, signature, ...fields } = s.body as {
			account: string;
			nonce: string;
			timestamp: number;
			signature: string;
		} & Record<string, unknown>;
		return v.verify({
			action: s.action,
			account,
			nonce,
			payload: relayPayload(s.action, fields),
			timestamp,
			signature
		});
	};

	beforeAll(async () => {
		await web.offlineStatus();
		await web.setAddress('email', '  grandma.private@example.net ', 'es');
		await web.setAddress('session', `05${'ab'.repeat(32)}`, 'fa');
		await web.startTelegram('zh-HK');
		await web.verifyCode('matrix', '123 456');
		await web.removeChannel('xmpp');
		await web.removeChannel('all');
		await web.openNoticeLink('AbCdEf_-123');
		await web.cancelChange('email');
		// The heartbeat: one "here" as it starts.
		web.startOfflinePresence();
		await vi.waitFor(() => expect(sent.at(-1)?.action).toBe('here'));
		web.stopOfflinePresence();
	});

	it('the browser sent every action', () => {
		expect(sent.map((s) => s.action)).toEqual([
			'status',
			'set',
			'set',
			'set',
			'verify',
			'remove',
			'remove',
			'open',
			'cancel',
			'here'
		]);
	});

	it('the relay accepts every one of them', async () => {
		for (const s of sent)
			expect(await check(s), `${s.action} ${JSON.stringify(s.body)}`).toEqual({ ok: true });
	});

	it('each signature is accepted once', async () => {
		verifier = verifierFor(AUDIENCE);
		const s0 = sent[0]!;
		expect(await check(s0)).toEqual({ ok: true });
		expect(await check(s0)).toEqual({ ok: false, reason: 'replayed' });
	});

	it('a signature made for another site is refused there', async () => {
		const other = verifierFor('another-instance-relay');
		for (const s of sent) expect((await check(s, other)).ok).toBe(false);
	});

	it('every request carries its own nonce, and Settings sends the network she is on', () => {
		const nonces = sent.map((s) => s.body.nonce);
		expect(new Set(nonces).size).toBe(sent.length);
		expect(nonces.every((n) => typeof n === 'string' && /^[0-9a-f]{32}$/.test(n))).toBe(true);
		const sets = sent.filter((s) => s.action === 'set');
		expect(sets.every((s) => s.body.net === 'clearnet')).toBe(true);
		expect(web.currentNet('abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion')).toBe(
			'tor'
		);
		expect(web.currentNet('x.b32.i2p')).toBe('i2p');
		expect(web.currentNet('site.loki')).toBe('loki');
	});

	it('a body changed on the way is refused', async () => {
		verifier = verifierFor(AUDIENCE);
		const set = sent.find((s) => s.action === 'set' && s.body.channel === 'email')!;
		const tampered = { ...set, body: { ...set.body, address: 'mallory@example.org' } };
		expect(await check(tampered)).toEqual({ ok: false, reason: 'signature_mismatch' });
		const asOther = { ...set, action: 'verify' as const };
		expect((await check(asOther)).ok).toBe(false);
	});
});
