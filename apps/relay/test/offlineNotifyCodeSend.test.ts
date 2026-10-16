/**
 * Offline notices: "send me a code" is answered at one fixed moment, whatever
 * happened — sent, failed, still on its way, or (the address's daily limit)
 * none sent at all — so the time an answer takes tells nobody whether others
 * asked for codes to that address today. A send still running then finishes
 * in the background, and only on the row that still waits for THAT code:
 *
 *   - sent: its Matrix room is kept for that code's row (never another one);
 *   - failed: that code's row gives back the address she had (or goes);
 *   - past its budget: a room it opens later is left, and a database error
 *     on the way never takes the relay down.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateKey } from '@beblurt/dblurt';

type Plan = { after: number; route?: string | null; fail?: boolean; never?: boolean };
const plans = new Map<string, Plan>();
const late: Array<(route: string | null) => void> = [];
vi.mock('../src/notify/dispatch.ts', async (orig) => {
	const real = await orig<typeof import('../src/notify/dispatch.ts')>();
	return {
		...real,
		dispatch: (_cfg: unknown, _channel: string, address: string) => {
			const p = plans.get(address)!;
			if (p.never) return new Promise<string | null>((r) => late.push(r));
			return new Promise((resolve, reject) =>
				setTimeout(
					() => (p.fail ? reject(new Error('refused')) : resolve(p.route ?? null)),
					p.after
				)
			);
		}
	};
});

const { OfflineNotifyEndpoints, notifyLimits, CODE_SEND_BUDGET_MS } = await import(
	'../src/notify/api.ts'
);
const { NotifySigVerifier, notifyCanonical, notifyPayload } = await import('../src/notify/sig.ts');
const { Presence } = await import('../src/notify/worker.ts');

const AUDIENCE = 'relay-test';
const key = PrivateKey.fromSeed('code-send-alice');
const MAC = Buffer.from('this-code');
const ANSWER_MS = 80;

function setup(opts: { send?: boolean; leaveFails?: boolean; budgetMs?: number } = {}) {
	const calls = {
		setRoute: [] as unknown[][],
		restore: [] as unknown[][],
		leave: [] as unknown[][]
	};
	const store = {
		async beginAddress() {
			return { ok: true, codeMac: MAC, send: opts.send ?? true };
		},
		async setRoute(...a: unknown[]) {
			calls.setRoute.push(a);
			return true;
		},
		async restoreOrDrop(...a: unknown[]) {
			calls.restore.push(a);
		},
		async queueLeave(...a: unknown[]) {
			calls.leave.push(a);
			if (opts.leaveFails) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
		},
		async claimLeaves() {
			return [];
		}
	};
	const cfg = {
		siteName: 'Test',
		audience: AUDIENCE,
		linkOrigin: 'https://site.example',
		linkOrigins: {},
		policy: { torSocks: '', hiddenOnly: false },
		email: { host: 'mail.example' },
		matrix: null,
		xmpp: null,
		telegram: null,
		session: null,
		off: {}
	};
	const app = new Hono();
	new OfflineNotifyEndpoints(
		cfg as never,
		store as never,
		new NotifySigVerifier(
			{ postingKeyAgreed: async () => ({ key: key.createPublic('BLT').toString() }) },
			AUDIENCE
		),
		new Presence(),
		notifyLimits(),
		{ codeAnswerMs: ANSWER_MS, codeSendBudgetMs: opts.budgetMs ?? CODE_SEND_BUDGET_MS }
	).register(app);
	const set = async (address: string) => {
		const fields = { channel: 'email', address, locale: 'en', net: 'clearnet' };
		const timestamp = Math.floor(Date.now() / 1000);
		const nonce = randomBytes(16).toString('hex');
		const digest = createHash('sha256')
			.update(
				notifyCanonical('set', AUDIENCE, 'alice', nonce, notifyPayload('set', fields), timestamp),
				'utf8'
			)
			.digest();
		const started = Date.now();
		const r = await app.request('/v1/notify/set', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...fields,
				account: 'alice',
				nonce,
				timestamp,
				signature: key.sign(digest).toString()
			})
		});
		return {
			status: ((await r.json()) as { status: string }).status,
			ms: Date.now() - started
		};
	};
	return { set, calls };
}

/** Virtual time (fake timers): exact, and no real waiting. */
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Let virtual time run, a millisecond at a time, until `p` settles. */
async function drive<T>(p: Promise<T>): Promise<T> {
	let done = false;
	void p.then(
		() => (done = true),
		() => (done = true)
	);
	for (let i = 0; !done && i < 100_000; i++) await vi.advanceTimersByTimeAsync(1);
	return p;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
	vi.useRealTimers();
	plans.clear();
	late.length = 0;
});

describe('offline notices: "send me a code" answers at one moment', () => {
	it('sent fast, failed fast, none sent, still on its way: all answered after the same wait', async () => {
		plans.set('fast@x.org', { after: 5, route: null });
		plans.set('fails@x.org', { after: 5, fail: true });
		plans.set('slow@x.org', { after: 400, route: null });
		const t = setup();
		const quiet = setup({ send: false });
		const answers = [
			await drive(t.set('fast@x.org')),
			await drive(t.set('fails@x.org')),
			await drive(quiet.set('fast@x.org')),
			await drive(t.set('slow@x.org'))
		];
		expect(answers.map((a) => a.status)).toEqual([
			'code_sent',
			'send_failed',
			'code_sent',
			'code_sent'
		]);
		// The same moment, to the millisecond (virtual time).
		expect(answers.map((a) => a.ms)).toEqual([ANSWER_MS, ANSWER_MS, ANSWER_MS, ANSWER_MS]);
	});

	it('a send that succeeds after the answer keeps its room — for THAT code only', async () => {
		plans.set('slow@x.org', { after: 300, route: '!room:hs' });
		const t = setup();
		expect((await drive(t.set('slow@x.org'))).status).toBe('code_sent');
		expect(t.calls.setRoute).toEqual([]);
		await wait(400);
		expect(t.calls.setRoute).toEqual([['alice', 'email', '!room:hs', { codeMac: MAC }]]);
	});

	it('a send that fails, now or after the answer, gives back what she had — for THAT code only', async () => {
		plans.set('fails@x.org', { after: 5, fail: true });
		plans.set('slowfail@x.org', { after: 300, fail: true });
		const t = setup();
		await drive(t.set('fails@x.org'));
		expect(t.calls.restore).toEqual([['alice', 'email', MAC]]);
		expect((await drive(t.set('slowfail@x.org'))).status).toBe('code_sent');
		await wait(400);
		expect(t.calls.restore).toEqual([
			['alice', 'email', MAC],
			['alice', 'email', MAC]
		]);
	});

	it('past its budget: the room it opens later is left, and a database error does not take the relay down', async () => {
		plans.set('hang@x.org', { after: 0, never: true });
		const t = setup({ leaveFails: true, budgetMs: 200 });
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on('unhandledRejection', onUnhandled);
		try {
			expect((await drive(t.set('hang@x.org'))).status).toBe('code_sent');
			await wait(250);
			expect(t.calls.restore).toEqual([['alice', 'email', MAC]]);
			// The send finishes after all, with a room nobody waits for.
			late[0]!('!late:hs');
			await wait(50);
			expect(t.calls.leave).toEqual([['alice', '!late:hs']]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});
