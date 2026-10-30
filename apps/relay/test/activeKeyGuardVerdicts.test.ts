/**
 * The relay's key check (policy/activeKeyGuard), the cases a deep review
 * found wrong or untested (2026-10-29):
 *
 *  - a definite mismatch is STICKY: one unanswered check used to overwrite it
 *    with "unknown", and for the next minute the relay signed again with a key
 *    the chain rejects (payouts rejected, retries used up, rows escalated);
 *  - with ONE RPC operator configured, that one node's "no such account" (a
 *    node still replaying answers `[]` for everyone) or "other keys" stopped
 *    every signup and payout — it is now undecided, with a warning saying so;
 *  - the owner key is accepted; an active authority that also names other
 *    accounts is undecided; a key that is listed but whose weight is below the
 *    threshold gets its own verdict and fix (it used to be told "not one of the
 *    active keys" while show-key listed that very key);
 *  - /v1/health's local block names the account and says no_account / bad_key;
 *  - the check runs on a timer: sooner while unanswered, and stop() stops it.
 */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authorityViewOf, type ActiveAuthorityView } from '../src/blurt/client.ts';
import { ActiveKeyGuard, judgeActiveKey } from '../src/policy/activeKeyGuard.ts';

const pub = (seed: string): string => PrivateKey.fromSeed(seed).createPublic('BLT').toString();
const MINE = pub('relay-mine');
const OTHER = pub('relay-other');
const OWNER = pub('relay-owner');
const POSTING = pub('relay-posting');

function captureLog() {
	const lines: Array<{ level: string; event: string; ctx?: Record<string, unknown> }> = [];
	const push = (level: string) => (event: string, ctx?: Record<string, unknown>) =>
		lines.push({ level, event, ctx });
	return { lines, log: { info: push('info'), warn: push('warn'), error: push('error') } };
}

const view = (o: Partial<Exclude<ActiveAuthorityView, { absent: true }>> = {}) => ({
	active: [OTHER],
	owner: [OWNER],
	posting: [POSTING],
	memo: null,
	delegated: false,
	...o
});

/** One get_accounts entry, as a node returns it. */
function account(
	active: unknown,
	owner: unknown = { weight_threshold: 1, account_auths: [], key_auths: [[OWNER, 1]] }
) {
	return {
		name: 'relayacct',
		owner,
		active,
		posting: { weight_threshold: 1, account_auths: [], key_auths: [[POSTING, 1]] },
		memo_key: pub('relay-memo')
	};
}
const judge = (acct: Record<string, unknown>, key = MINE) =>
	judgeActiveKey(key, authorityViewOf(acct), 0);

describe('a definite mismatch stays until a definite answer replaces it', () => {
	it('one unanswered check does not let the relay sign again', async () => {
		let answer: ActiveAuthorityView | null = view();
		const cap = captureLog();
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: MINE,
			lookup: async () => answer,
			log: cap.log
		});
		await g.check();
		expect(g.signingRefused()).toBe(true);
		answer = null; // the nodes could not be asked
		const s = await g.check();
		expect(s.state).toBe('mismatch');
		expect(g.signingRefused()).toBe(true);
		expect(g.status()).toMatchObject({ state: 'mismatch', latest_check: 'unanswered' });
		// The warning says signing STAYS stopped (not "goes on as normal"), and the
		// mismatch line is repeated, so it does not scroll away.
		const warn = cap.lines.find((l) => l.event === 'active_key_check_unanswered');
		expect(String(warn?.ctx?.effect)).toMatch(/Signing stays stopped/);
		expect(cap.lines.filter((l) => l.event === 'active_key_not_on_chain')).toHaveLength(2);
		// The lookup throwing is unanswered too.
		answer = null;
		const g2 = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: MINE,
			lookup: async () => {
				throw new Error('boom');
			},
			log: captureLog().log
		});
		await g2.check();
		expect(g2.signingRefused()).toBe(false); // no earlier verdict: refuses nothing
	});

	it('a definite "right key" ends it, and a later unanswered check keeps "ok"', async () => {
		let answer: ActiveAuthorityView | null = view();
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: MINE,
			lookup: async () => answer,
			log: captureLog().log
		});
		await g.check();
		answer = null;
		await g.check();
		expect(g.signingRefused()).toBe(true);
		answer = view({ active: [MINE] });
		await g.check();
		expect(g.signingRefused()).toBe(false);
		expect(g.status()).not.toHaveProperty('latest_check');
		answer = null;
		expect((await g.check()).state).toBe('ok');
	});

	it('a definitely different answer replaces it (the authority now names other accounts)', async () => {
		let answer: ActiveAuthorityView | null = view();
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: MINE,
			lookup: async () => answer,
			log: captureLog().log
		});
		await g.check();
		expect(g.signingRefused()).toBe(true);
		answer = view({ delegated: true });
		expect((await g.check()).state).toBe('unknown');
		expect(g.signingRefused()).toBe(false);
	});
});

describe('one RPC operator alone cannot stop the relay', () => {
	const servers: http.Server[] = [];
	let dir = '';
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'akg-single-'));
		process.env.MORPHIT_RPC_HEALTH_STATE = join(dir, 'h.json');
	});
	afterAll(() => {
		for (const s of servers) s.close();
		rmSync(dir, { recursive: true, force: true });
	});
	async function node(host: string, result: unknown): Promise<string> {
		const srv = http.createServer((req, res) => {
			let b = '';
			req.on('data', (d) => (b += d));
			req.on('end', () => {
				const j = JSON.parse(b) as { id: number };
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
			});
		});
		await new Promise<void>((r) => srv.listen(0, host, () => r()));
		servers.push(srv);
		return `http://${host}:${(srv.address() as { port: number }).port}`;
	}
	async function guardOver(urls: string[], key = MINE) {
		const { BlurtClient } = await import('../src/blurt/client.ts');
		const blurt = new BlurtClient(urls, 100);
		const cap = captureLog();
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: key,
			lookup: (n) => blurt.activeAuthorityAgreed(n),
			log: cap.log
		});
		await g.check();
		return { g, cap };
	}

	it('its "no such account" (e.g. a node still replaying the chain): undecided, with a warning why', async () => {
		const { g, cap } = await guardOver([await node('127.0.0.91', [])]);
		expect(g.signingRefused()).toBe(false);
		expect(g.status().state).toBe('unknown');
		const warn = cap.lines.find((l) => l.level === 'warn');
		expect(String(warn?.ctx?.why)).toMatch(/only one Blurt RPC operator/);
		expect(cap.lines.some((l) => l.level === 'error')).toBe(false);
	});

	it('its "other keys": undecided too', async () => {
		const { g } = await guardOver([
			await node('127.0.0.92', [
				account({ weight_threshold: 1, account_auths: [], key_auths: [[OTHER, 1]] })
			])
		]);
		expect(g.signingRefused()).toBe(false);
		expect(g.status().state).toBe('unknown');
	});

	it('its "this is the key": ok (it can only let signing go on)', async () => {
		const { g } = await guardOver([
			await node('127.0.0.93', [
				account({ weight_threshold: 1, account_auths: [], key_auths: [[MINE, 1]] })
			])
		]);
		expect(g.status().state).toBe('ok');
	});

	it('two operators agreeing "no such account": refused, with the files that set the account name', async () => {
		const { g, cap } = await guardOver([
			await node('127.0.0.94', []),
			await node('127.0.0.95', [])
		]);
		expect(g.signingRefused()).toBe(true);
		expect(g.status()).toMatchObject({ state: 'mismatch', no_account: true, account: 'relayacct' });
		const fix = String(cap.lines.find((l) => l.level === 'error')?.ctx?.fix);
		expect(fix).toContain('sudo nano /etc/morphit/relay.env and /opt/morphit/morphit.env');
		expect(fix).toContain('MORPHIT_RELAY_ACCOUNT=');
		expect(fix).toContain('sudo systemctl restart morphit-relay');
		expect(fix).not.toMatch(/morphit-ops edit\b(?!-)/);
	});
});

describe('what the chain lists, judged', () => {
	it('the owner key signs where the active key is required: ok', () => {
		expect(
			judge(account({ weight_threshold: 1, account_auths: [], key_auths: [[OTHER, 1]] }), OWNER)
				.state
		).toBe('ok');
	});

	it('an owner authority held only by other accounts does not make an unlisted key ok', () => {
		const s = judge(
			account(
				{ weight_threshold: 1, account_auths: [], key_auths: [[OTHER, 1]] },
				{ weight_threshold: 1, account_auths: [['someone', 1]], key_auths: [] }
			)
		);
		expect(s.state).toBe('mismatch');
	});

	it('an active authority that also names other accounts: undecided, never refused', () => {
		const s = judge(
			account({ weight_threshold: 1, account_auths: [['someone', 1]], key_auths: [[OTHER, 1]] })
		);
		expect(s.state).toBe('unknown');
	});

	it('a weight given as text still counts', () => {
		expect(
			judge(account({ weight_threshold: 1, account_auths: [], key_auths: [[MINE, '1']] })).state
		).toBe('ok');
	});

	it('listed, but below the threshold (two of two keys): its own verdict, weight and threshold', async () => {
		const acct = account({
			weight_threshold: 2,
			account_auths: [],
			key_auths: [
				[MINE, 1],
				[OTHER, 1]
			]
		});
		const s = judge(acct);
		expect(s).toMatchObject({ state: 'mismatch', belowThreshold: { weight: 1, threshold: 2 } });
		const cap = captureLog();
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: MINE,
			lookup: async () => authorityViewOf(acct),
			log: cap.log
		});
		await g.check();
		expect(g.status()).toMatchObject({
			found_as: 'active_below_threshold',
			weight: 1,
			threshold: 2
		});
		const line = cap.lines.find((l) => l.level === 'error')!;
		expect(String(line.ctx?.problem)).toMatch(
			/is listed on @relayacct's active authority, but cannot sign alone/
		);
		expect(String(line.ctx?.problem)).not.toMatch(/not one of/);
		expect(String(line.ctx?.fix)).toMatch(/sudo morphit-ops edit-active-key/);
	});

	it('two nodes listing the same keys in another order agree', () => {
		const a = authorityViewOf(
			account({
				weight_threshold: 1,
				account_auths: [],
				key_auths: [
					[OTHER, 1],
					[MINE, 1]
				]
			})
		);
		const b = authorityViewOf(
			account({
				weight_threshold: 1,
				account_auths: [],
				key_auths: [
					[MINE, 1],
					[OTHER, 1]
				]
			})
		);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("/v1/health's local block", () => {
	it('names the account, and says bad_key for a key file that holds no key', async () => {
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: null,
			lookup: async () => view(),
			log: captureLog().log
		});
		await g.check();
		expect(g.status()).toMatchObject({ state: 'mismatch', account: 'relayacct', bad_key: true });
		expect(g.status()).not.toHaveProperty('no_account');
	});
});

describe('the check on a timer', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('sooner while unanswered, at the recheck interval once answered, and nothing after stop()', async () => {
		vi.useFakeTimers();
		const answers: Array<ActiveAuthorityView | null> = [null, null, view({ active: [MINE] })];
		let asked = 0;
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: MINE,
			lookup: async () => answers[Math.min(asked++, answers.length - 1)] ?? null,
			log: captureLog().log,
			retryMs: 1_000,
			recheckMs: 60_000
		});
		await g.start();
		expect(asked).toBe(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(asked).toBe(2);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(asked).toBe(3);
		expect(g.status().state).toBe('ok');
		// Answered: the next one waits for the recheck interval.
		await vi.advanceTimersByTimeAsync(59_000);
		expect(asked).toBe(3);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(asked).toBe(4);
		g.stop();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(asked).toBe(4);
	});

	it('a mismatch kept through an unanswered check is asked about again soon', async () => {
		vi.useFakeTimers();
		const answers: Array<ActiveAuthorityView | null> = [view(), null, view({ active: [MINE] })];
		let asked = 0;
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: MINE,
			lookup: async () => answers[Math.min(asked++, answers.length - 1)] ?? null,
			log: captureLog().log,
			retryMs: 1_000,
			recheckMs: 60_000
		});
		await g.start();
		expect(g.signingRefused()).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(asked).toBe(2);
		expect(g.signingRefused()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(asked).toBe(3);
		expect(g.signingRefused()).toBe(false);
		g.stop();
	});
});
