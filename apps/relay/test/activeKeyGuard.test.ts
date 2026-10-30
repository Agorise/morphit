/**
 * The relay checks its own key against the chain (policy/activeKeyGuard).
 *
 * `edit-active-key` and the docs said the relay refuses a key that is not on
 * the account's active authority; it only decrypted the key, started, took
 * signups and queued payments the chain would reject. Now: a definite
 * mismatch (as two RPC operators agree) stops all signing — signups are
 * refused up front and queued payments stay queued — with a plain log line
 * that names the fix; the relay keeps running (an exit under Restart=always
 * is a crash loop). An unanswered check refuses nothing.
 */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { PrivateKey } from '@beblurt/dblurt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ACTIVE_WIF = PrivateKey.fromSeed('relay-active').toString();
const POSTING_WIF = PrivateKey.fromSeed('relay-posting').toString();
const pub = (wif: string): string => PrivateKey.fromString(wif).createPublic('BLT').toString();
const ACTIVE = pub(ACTIVE_WIF);
const POSTING = pub(POSTING_WIF);
const OWNER = pub(PrivateKey.fromSeed('relay-owner').toString());
const OTHER = pub(PrivateKey.fromSeed('someone-else').toString());

const servers: http.Server[] = [];
/** A Blurt node on its own loopback address answering get_accounts. */
async function node(host: string, activeKey: string | null): Promise<string> {
	const srv = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			const j = JSON.parse(body) as { id: number; method: string };
			const result = j.method.endsWith('get_accounts')
				? activeKey === null
					? []
					: [
							{
								name: 'relayacct',
								owner: { weight_threshold: 1, account_auths: [], key_auths: [[OWNER, 1]] },
								active: { weight_threshold: 1, account_auths: [], key_auths: [[activeKey, 1]] },
								posting: { weight_threshold: 1, account_auths: [], key_auths: [[POSTING, 1]] },
								memo_key: OTHER
							}
						]
				: null;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, host, () => r()));
	servers.push(srv);
	return `http://${host}:${(srv.address() as { port: number }).port}`;
}

let work = '';
beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), 'akg-'));
	process.env.MORPHIT_RPC_HEALTH_STATE = join(work, 'h.json');
});
afterAll(() => {
	for (const s of servers) s.close();
	rmSync(work, { recursive: true, force: true });
});

function captureLog() {
	const lines: Array<{ level: string; event: string; ctx?: Record<string, unknown> }> = [];
	return {
		lines,
		log: {
			info: (event: string, ctx?: Record<string, unknown>) =>
				lines.push({ level: 'info', event, ctx }),
			warn: (event: string, ctx?: Record<string, unknown>) =>
				lines.push({ level: 'warn', event, ctx }),
			error: (event: string, ctx?: Record<string, unknown>) =>
				lines.push({ level: 'error', event, ctx })
		}
	};
}

async function guardFor(wif: string, urls: string[]) {
	const { BlurtClient } = await import('../src/blurt/client.ts');
	const { ActiveKeyGuard } = await import('../src/policy/activeKeyGuard.ts');
	const blurt = new BlurtClient(urls, 100);
	const cap = captureLog();
	const guard = new ActiveKeyGuard({
		account: 'relayacct',
		publicKey: pub(wif),
		lookup: (n) => blurt.activeAuthorityAgreed(n),
		log: cap.log
	});
	await guard.check();
	return { guard, cap };
}

describe("the relay's key against the chain", () => {
	it('the active key: signing goes on', async () => {
		const { guard, cap } = await guardFor(ACTIVE_WIF, [
			await node('127.0.0.41', ACTIVE),
			await node('127.0.0.42', ACTIVE)
		]);
		expect(guard.signingRefused()).toBe(false);
		expect(guard.status().state).toBe('ok');
		expect(cap.lines.some((l) => l.level === 'error')).toBe(false);
	});

	it('the posting key: the relay refuses to sign and says what to run', async () => {
		const { guard, cap } = await guardFor(POSTING_WIF, [
			await node('127.0.0.43', ACTIVE),
			await node('127.0.0.44', ACTIVE)
		]);
		expect(guard.signingRefused()).toBe(true);
		const line = cap.lines.find((l) => l.level === 'error');
		expect(line?.event).toBe('active_key_not_on_chain');
		expect(String(line?.ctx?.problem)).toMatch(/POSTING key, not its ACTIVE key/);
		expect(String(line?.ctx?.fix)).toMatch(
			/On this server: sudo morphit-ops edit-active-key .* sudo systemctl restart morphit-relay/
		);
		expect(guard.status()).toMatchObject({
			state: 'mismatch',
			found_as: 'posting',
			public_key: POSTING
		});
	});

	it('one node naming another key cannot stop the relay (no agreement: nothing refused)', async () => {
		const { guard } = await guardFor(ACTIVE_WIF, [
			await node('127.0.0.45', OTHER),
			await node('127.0.0.46', ACTIVE)
		]);
		expect(guard.signingRefused()).toBe(false);
		expect(guard.status().state).toBe('unknown');
	});

	it('a chain that cannot be reached refuses nothing', async () => {
		const { guard } = await guardFor(POSTING_WIF, ['http://127.0.0.47:9', 'http://127.0.0.48:9']);
		expect(guard.signingRefused()).toBe(false);
	}, 60_000);

	it('the key fixed on the chain later: signing resumes at the next check', async () => {
		const { ActiveKeyGuard } = await import('../src/policy/activeKeyGuard.ts');
		let chainActive = OTHER;
		const cap = captureLog();
		const guard = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: ACTIVE,
			lookup: async () => ({
				active: [chainActive],
				owner: [OWNER],
				posting: [POSTING],
				memo: null,
				delegated: false
			}),
			log: cap.log
		});
		await guard.check();
		expect(guard.signingRefused()).toBe(true);
		chainActive = ACTIVE;
		await guard.check();
		expect(guard.signingRefused()).toBe(false);
	});
});

describe('while the key is refused', () => {
	const refused = { signingRefused: () => true };

	it('a signup is refused before any work', async () => {
		const { CreateEndpoint } = await import('../src/api/create.ts');
		const ep = new CreateEndpoint(
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			0,
			{} as never,
			true,
			{} as never,
			{} as never,
			null,
			'off',
			4,
			null,
			refused
		);
		const app = new Hono();
		ep.register(app);
		const res = await app.request('/v1/account/create', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
		expect(res.status).toBe(503);
		expect(((await res.json()) as { code: string }).code).toBe('signups_disabled');
	});

	it('an invite is refused too (a signup could not be finished)', async () => {
		const { InviteEndpoint } = await import('../src/api/invite.ts');
		const ep = new InviteEndpoint(
			true,
			{} as never,
			{} as never,
			3,
			{} as never,
			{} as never,
			null,
			refused
		);
		const app = new Hono();
		ep.register(app);
		const res = await app.request('/v1/account/invite', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
		expect(res.status).toBe(503);
	});

	it('queued payments are not touched (no row read, nothing broadcast)', async () => {
		const { RelayQueueDrainer } = await import('../src/queue/drainer.ts');
		const asked: string[] = [];
		const db = {
			query: async (sql: string) => {
				asked.push(sql);
				return { rows: [{ unsettled: '0', escalated: '0' }], rowCount: 1 };
			}
		};
		const blurt = new Proxy(
			{},
			{
				get: () => () => {
					throw new Error('the drainer reached the chain');
				}
			}
		);
		const d = new RelayQueueDrainer(
			{ queueBatchSize: 20, queueMaxRetries: 10, queuePollIntervalMs: 60_000 } as never,
			db as never,
			blurt as never,
			refused
		);
		const r = await d.drainOnce();
		expect(r).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
		expect(
			asked.some(
				(q) => /relay_pending_transfers[\s\S]*ORDER BY/i.test(q) && !/count\(\*\)/i.test(q)
			)
		).toBe(false);
	});

	it('a refusal that starts during a batch stops the rest of that batch (no retry used up)', async () => {
		const { RelayQueueDrainer } = await import('../src/queue/drainer.ts');
		let refusedNow = false;
		const gate = { signingRefused: () => refusedNow };
		const db = { query: async () => ({ rows: [{ unsettled: '0', escalated: '0' }], rowCount: 1 }) };
		const d = new RelayQueueDrainer(
			{ queueBatchSize: 20, queueMaxRetries: 10, queuePollIntervalMs: 60_000 } as never,
			db as never,
			{} as never,
			gate
		);
		const processed: number[] = [];
		const internals = d as unknown as {
			selectPending: () => Promise<unknown[]>;
			processRow: (row: { id: number }) => Promise<'done'>;
		};
		internals.selectPending = async () => [{ id: 1 }, { id: 2 }, { id: 3 }];
		internals.processRow = async (row) => {
			processed.push(row.id);
			refusedNow = true; // the key check turns to "refused" after the first payment
			return 'done';
		};
		const r = await d.drainOnce();
		expect(processed).toEqual([1]);
		expect(r).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
	});
});
