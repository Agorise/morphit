#!/usr/bin/env tsx
/**
 * Signup / relay-spend integrity smoke (findings D2, D4, D5,
 * D6, D10). Every scenario exercises BEHAVIOUR through the real entry points
 * (the relay's BlurtClient against local mock Blurt RPC nodes, the real
 * CreateEndpoint mounted on Hono, the real HealthService) — no source regexes.
 *
 *   D2  a node that accepts a broadcast but loses the answer must not make the
 *       relay SIGN A SECOND, DIFFERENT transaction on the next node (a second
 *       2 BLURT dust / 10 BLURT bonus / account_create). The same signed bytes go
 *       to every node, and a create whose account landed with OUR keys is a
 *       SUCCESS: counted against the ceiling, invite consumed, dust sent once.
 *   D4  a live account_creation_fee more than 1.5x the configured one is refused
 *       before anything is broadcast (stable code `relay_fee_spike`), and the
 *       funding pre-check uses the LIVE fee.
 *   D5  concurrent creates from one IP bucket cannot beat the per-IP daily cap
 *       and spacing (they used to only PEEK the limiter until a broadcast landed).
 *   D6  an invite claimed by an in-flight create cannot be swept free while that
 *       create is still running (it used to be freed after 120 s, allowing a
 *       second account from one invite).
 *   D10 when the balance poll keeps failing the relay must stop trusting the old
 *       balance (it used to keep it forever, with no stale flag).
 *
 * Usage: cd apps/relay && ../../node_modules/.bin/tsx --tsconfig ../../tsconfig.smoke.json scripts/signup-spend-integrity-smoke.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { PrivateKey } from '@beblurt/dblurt';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MORPHIT_RPC_HEALTH_STATE = join(mkdtempSync(join(tmpdir(), 'ssi-')), 'h.json');

const { BlurtClient } = await import('../src/blurt/client.ts');
const { CreateEndpoint } = await import('../src/api/create.ts');
const { HealthService } = await import('../src/api/health.ts');
const { Limiter } = await import('../src/middleware/ratelimit.ts');
const { GlobalDailyCeiling } = await import('../src/policy/globalDailyCeiling.ts');
const { InviteTokenService } = await import('../src/policy/inviteToken.ts');
const { ManualClock } = await import('../src/policy/clock.ts');

let failures = 0;
let scenarios = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
	scenarios++;
	try {
		await fn();
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

const WIF = '5JRaypasxMx1L97ZUX7YuC5Psb5EAbF821kkAGtBj7xCJFQcbLg';
const K = (s: string): string =>
	PrivateKey.fromSeed('ssi-seed-' + s)
		.createPublic('BLT')
		.toString();
const SECRET = Buffer.from('signup-spend-integrity-secret-000', 'utf8');

// ─── A tiny shared "chain" + mock RPC nodes ─────────────────────────────────
interface Chain {
	accounts: Map<string, { owner: string; balance: string }>;
	/** Distinct signed transactions that reached ANY node (by first signature). */
	signed: Set<string>;
	/** Operations actually applied to the chain. */
	applied: Array<[string, Record<string, unknown>]>;
	fee: string;
}
function newChain(fee = '100.000 BLURT'): Chain {
	return {
		accounts: new Map([['relay', { owner: K('relay'), balance: '9000.000 BLURT' }]]),
		signed: new Set(),
		applied: [],
		fee
	};
}
/** mode 'ok' answers; 'lose' applies the tx then never answers (the socket is
 *  dropped after `loseMs`) — a node whose reply is lost after acceptance. */
async function mockNode(
	chain: Chain,
	mode: 'ok' | 'lose',
	loseMs = 11_000
): Promise<{ url: string; close: () => void }> {
	const srv = http.createServer((req, res) => {
		let b = '';
		req.on('data', (c) => (b += c));
		req.on('end', () => {
			const j = JSON.parse(b) as { id: number; method: string; params: unknown[] };
			const reply = (result: unknown): void => {
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
			};
			const error = (message: string): void => {
				res.setHeader('content-type', 'application/json');
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: j.id,
						error: { code: -32000, message, data: { message } }
					})
				);
			};
			const m = j.method;
			const now = new Date();
			const hb = Math.floor(now.getTime() / 3000);
			if (m.endsWith('get_chain_properties'))
				return reply({ account_creation_fee: chain.fee, maximum_block_size: 65536 });
			if (m.endsWith('get_dynamic_global_properties'))
				return reply({
					head_block_number: hb,
					last_irreversible_block_num: hb - 2,
					head_block_id: hb.toString(16).padStart(8, '0') + 'ab'.repeat(16),
					time: now.toISOString().slice(0, 19),
					total_vesting_fund_blurt: '1.000 BLURT',
					total_vesting_shares: '1.000000 VESTS'
				});
			if (m.endsWith('get_accounts')) {
				const names = (j.params[0] as string[]) ?? [];
				return reply(
					names
						.filter((n) => chain.accounts.has(n))
						.map((n) => ({
							name: n,
							balance: chain.accounts.get(n)!.balance,
							owner: {
								weight_threshold: 1,
								account_auths: [],
								key_auths: [[chain.accounts.get(n)!.owner, 1]]
							},
							posting: { weight_threshold: 1, account_auths: [], key_auths: [[K(n + 'p'), 1]] },
							created: '2026-01-01T00:00:00'
						}))
				);
			}
			if (m.includes('broadcast_transaction')) {
				const tx = j.params[0] as {
					signatures: string[];
					operations: Array<[string, Record<string, unknown>]>;
				};
				const sig = tx.signatures[0]!;
				if (chain.signed.has(sig)) return error('Duplicate transaction check failed');
				for (const [op, body] of tx.operations) {
					if (op === 'account_create' && chain.accounts.has(String(body.new_account_name)))
						return error(
							'could not insert object, most likely a uniqueness constraint was violated'
						);
				}
				chain.signed.add(sig);
				for (const [op, body] of tx.operations) {
					chain.applied.push([op, body]);
					if (op === 'account_create') {
						const owner = (body.owner as { key_auths: [string, number][] }).key_auths[0]![0];
						chain.accounts.set(String(body.new_account_name), { owner, balance: '0.000 BLURT' });
					}
				}
				if (mode === 'lose') {
					setTimeout(() => req.socket.destroy(), loseMs);
					return;
				}
				return reply({});
			}
			reply(null);
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	return {
		url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
		close: () => srv.close()
	};
}
/** Warm the pool so the LOSING node is the fastest-known (tried first). */
async function warm(c: InstanceType<typeof BlurtClient>, first: string): Promise<void> {
	for (let i = 0; i < 4; i++) await c.getDynamicGlobalProperties();
	const eps = (
		c as unknown as { pool: { endpoints: Array<{ url: string; ewmaLatencyMs: number | null }> } }
	).pool.endpoints;
	for (const e of eps) e.ewmaLatencyMs = e.url === first ? 1 : 50;
}
const auth = (k: string) => ({ weight_threshold: 1, account_auths: [], key_auths: [[k, 1]] });
const body = (tok: string, name: string) =>
	JSON.stringify({
		invite_token: tok,
		op: {
			new_account_name: name,
			owner: auth(K(name + 'o')),
			active: auth(K(name + 'a')),
			posting: auth(K(name + 'p')),
			memo_key: K(name + 'm'),
			json_metadata: ''
		}
	});
function mountCreate(opts: {
	blurt: unknown;
	clock?: InstanceType<typeof ManualClock>;
	health?: unknown;
	ceiling?: InstanceType<typeof GlobalDailyCeiling>;
	/** Per-IP limits; invite-focused scenarios relax them so the spacing rule
	 *  does not answer first. */
	dailyMax?: number;
	spacingMinutes?: number;
}) {
	const ceiling = opts.ceiling ?? new GlobalDailyCeiling(50, () => {});
	const invites = new InviteTokenService({
		secret: SECRET,
		...(opts.clock ? { clock: opts.clock } : {})
	});
	const ep = new CreateEndpoint(
		{ relayAccount: 'relay', relayActiveKeyWif: WIF } as never,
		opts.blurt as never,
		new Limiter(5, 3_600_000),
		new Limiter(opts.dailyMax ?? 2, 86_400_000),
		opts.spacingMinutes ?? 60,
		(opts.health ?? { canAcceptCreation: () => true }) as never,
		true,
		ceiling,
		invites,
		null,
		'strict',
		4,
		null
	);
	const app = new Hono();
	ep.register(app);
	const post = (tok: string, name: string) =>
		app.request('/v1/account/create', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: body(tok, name)
		});
	return { post, invites, ceiling };
}

console.log('signup / relay-spend integrity smoke:\n');

await check(
	'D2: a lost broadcast reply does not make the relay sign a SECOND transfer',
	async () => {
		const chain = newChain();
		const A = await mockNode(chain, 'lose');
		const B = await mockNode(chain, 'ok');
		try {
			const c = new BlurtClient([A.url, B.url], 100, { broadcastAttemptTimeoutMs: 3_000 } as never);
			await warm(c, A.url);
			await c
				.broadcastTransfer({
					from: 'relay',
					fromActiveWif: WIF,
					to: 'alice',
					amountBlurt: 2,
					memo: 'morphit:signup_dust'
				})
				.catch(() => {});
			const transfers = chain.applied.filter(([op]) => op === 'transfer').length;
			assert(
				chain.signed.size === 1 && transfers === 1,
				`distinct signed txs=${chain.signed.size}, transfers applied=${transfers} (expected 1/1)`
			);
		} finally {
			A.close();
			B.close();
		}
	}
);

await check(
	'D2: account_create landed but reply lost → success, counted, invite consumed, dust once',
	async () => {
		const chain = newChain();
		const A = await mockNode(chain, 'lose');
		const B = await mockNode(chain, 'ok');
		try {
			const c = new BlurtClient([A.url, B.url], 100, { broadcastAttemptTimeoutMs: 3_000 } as never);
			await warm(c, A.url);
			const h = mountCreate({ blurt: c, dailyMax: 50, spacingMinutes: 0 });
			const tok = h.invites.issue('unknown').token;
			const r = await h.post(tok, 'amberfalcon');
			const j = (await r.json()) as { status: string; code?: string };
			const dust = chain.applied.filter(
				([op, b]) => op === 'transfer' && b.to === 'amberfalcon'
			).length;
			const again = await h.post(tok, 'coralheron');
			assert(
				r.status === 200 &&
					j.status === 'broadcast' &&
					h.ceiling.currentCount() === 1 &&
					dust === 1 &&
					again.status === 410,
				`HTTP ${r.status} ${j.code ?? j.status}; ceiling=${h.ceiling.currentCount()}; dust transfers=${dust}; invite reuse HTTP ${again.status} (expected 200/1/1/410)`
			);
			assert(
				chain.applied.filter(([op]) => op === 'account_create').length === 1,
				'more than one account_create applied'
			);
		} finally {
			A.close();
			B.close();
		}
	}
);

await check(
	'D2: a retry for an account that already exists with OUR keys is not "taken by someone else"',
	async () => {
		const chain = newChain();
		chain.accounts.set('quietlantern', { owner: K('quietlanterno'), balance: '0.000 BLURT' });
		const B = await mockNode(chain, 'ok');
		try {
			const c = new BlurtClient([B.url], 100);
			const h = mountCreate({ blurt: c });
			const r = await h.post(h.invites.issue('unknown').token, 'quietlantern');
			const j = (await r.json()) as { status: string; code?: string };
			assert(
				r.status === 200 && j.status === 'broadcast' && chain.signed.size === 0,
				`HTTP ${r.status} ${j.code ?? j.status}, broadcasts=${chain.signed.size} (expected 200, no broadcast)`
			);
		} finally {
			B.close();
		}
	}
);

await check(
	'D4: live fee 10x the configured fee → nothing broadcast, code relay_fee_spike',
	async () => {
		const chain = newChain('1000.000 BLURT');
		const B = await mockNode(chain, 'ok');
		try {
			const c = new BlurtClient([B.url], 100);
			const h = mountCreate({ blurt: c });
			const r = await h.post(h.invites.issue('unknown').token, 'saffronpike');
			const j = (await r.json()) as { code?: string };
			assert(
				chain.signed.size === 0,
				`a transaction was broadcast (fee paid would be ${chain.fee})`
			);
			assert(
				r.status === 503 && j.code === 'relay_fee_spike',
				`HTTP ${r.status} code=${j.code} (expected 503 relay_fee_spike)`
			);
		} finally {
			B.close();
		}
	}
);

await check('D4: the funding pre-check uses the LIVE fee, not the configured one', async () => {
	const chain = newChain('150.000 BLURT');
	chain.accounts.set('relay', { owner: K('relay'), balance: '120.000 BLURT' });
	const B = await mockNode(chain, 'ok');
	try {
		const c = new BlurtClient([B.url], 100);
		const hs = new HealthService(
			{ relayAccount: 'relay', accountCreationFeeBlurt: 100, verboseHealth: true } as never,
			c,
			process.hrtime.bigint()
		);
		await (hs as unknown as { refresh(): Promise<void> }).refresh();
		assert(hs.canAcceptCreation() === false, 'balance 120 accepted against a live fee of 150');
	} finally {
		B.close();
	}
});

await check(
	'D4: a fee spike is reported as relay_fee_spike, not "out of funds", even when the balance is short',
	async () => {
		const chain = newChain('1000.000 BLURT');
		chain.accounts.set('relay', { owner: K('relay'), balance: '500.000 BLURT' });
		const B = await mockNode(chain, 'ok');
		try {
			const c = new BlurtClient([B.url], 100);
			const hs = new HealthService(
				{ relayAccount: 'relay', accountCreationFeeBlurt: 100, verboseHealth: true } as never,
				c,
				process.hrtime.bigint()
			);
			await (hs as unknown as { refresh(): Promise<void> }).refresh();
			const h = mountCreate({ blurt: c, health: hs });
			const r = await h.post(h.invites.issue('unknown').token, 'saffronpike');
			const j = (await r.json()) as { code?: string };
			assert(
				r.status === 503 && j.code === 'relay_fee_spike' && chain.signed.size === 0,
				`HTTP ${r.status} code=${j.code} broadcasts=${chain.signed.size}`
			);
		} finally {
			B.close();
		}
	}
);

await check(
	'D5: concurrent creates from one IP bucket respect the 2/day cap + spacing',
	async () => {
		let n = 0;
		const blurt = {
			getAccount: async () => null,
			getChainProperties: async () => ({
				account_creation_fee: '100.000 BLURT',
				maximum_block_size: 65536
			}),
			broadcastAccountCreate: async () => {
				n++;
				await new Promise((r) => setTimeout(r, 200));
				return { id: 't' + n, block_num: 1, trx_num: 0, expired: false };
			},
			broadcastTransfer: async () => ({ id: 'd', block_num: 1, trx_num: 0, expired: false })
		};
		const h = mountCreate({ blurt });
		const names = ['kestrelwing', 'marbleotter', 'velvetcomet', 'hollowmaple', 'brightsorrel'];
		const toks = names.map(() => h.invites.issue('unknown').token);
		const rs = await Promise.all(names.map((nm, i) => h.post(toks[i]!, nm)));
		const ok = rs.filter((r) => r.status === 200).length;
		assert(
			ok <= 1 && n <= 1,
			`${ok} accounts created concurrently from one bucket (${n} broadcasts); at most 1 allowed (60-min spacing)`
		);
	}
);

await check(
	'D6: an invite held by a still-running create is not freed by the claim sweep',
	async () => {
		const clock = new ManualClock(new Date());
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		let first = true;
		let n = 0;
		const blurt = {
			getAccount: async () => null,
			getChainProperties: async () => ({
				account_creation_fee: '100.000 BLURT',
				maximum_block_size: 65536
			}),
			broadcastAccountCreate: async () => {
				n++;
				if (first) {
					first = false;
					await gate;
				}
				return { id: 't' + n, block_num: 1, trx_num: 0, expired: false };
			},
			broadcastTransfer: async () => ({ id: 'd', block_num: 1, trx_num: 0, expired: false })
		};
		const h = mountCreate({ blurt, clock, dailyMax: 50, spacingMinutes: 0 });
		const tok = h.invites.issue('unknown').token;
		const p1 = h.post(tok, 'hollowmaple');
		await new Promise((r) => setTimeout(r, 50));
		clock.advance(121_000);
		(h.invites as unknown as { sweep(): void }).sweep();
		const second = await h.post(tok, 'brightsorrel');
		release();
		await p1;
		assert(
			second.status === 410 && n === 1,
			`second use of one invite → HTTP ${second.status}, broadcasts=${n} (expected 410, 1)`
		);
	}
);

await check(
	'D10: after the balance poll keeps failing, the old balance is no longer trusted',
	async () => {
		let fail = false;
		const blurt = {
			getAccount: async () => {
				if (fail) throw new Error('all RPC endpoints unavailable: fetch failed');
				return {
					name: 'relay',
					balance: '5000.000 BLURT',
					created: '',
					pending_claimed_accounts: 0,
					posting_pubkey: undefined
				};
			},
			getChainProperties: async () => {
				if (fail) throw new Error('all RPC endpoints unavailable: fetch failed');
				return { account_creation_fee: '100.000 BLURT', maximum_block_size: 65536 };
			},
			endpointSnapshot: () => []
		};
		const hs = new HealthService(
			{
				relayAccount: 'relay',
				accountCreationFeeBlurt: 100,
				verboseHealth: true,
				hiddenOnly: false,
				pushEnabled: false
			} as never,
			blurt as never,
			process.hrtime.bigint()
		);
		const inner = hs as unknown as {
			refresh(): Promise<void>;
			snapshot: { last_refresh_unix: number };
		};
		await inner.refresh();
		fail = true;
		// The last good poll was 5 minutes ago; every poll since has failed.
		inner.snapshot.last_refresh_unix -= 300;
		for (let i = 0; i < 3; i++) await inner.refresh().catch(() => {});
		const app = new Hono();
		hs.register(app);
		const b = (await (await app.request('/v1/health')).json()) as { stale?: boolean };
		assert(
			hs.canAcceptCreation() === false && b.stale === true,
			`canAcceptCreation=${hs.canAcceptCreation()} stale=${b.stale} (expected false/true)`
		);
	}
);

console.log('');
if (failures > 0) {
	console.log(`✗ ${failures} of ${scenarios} signup-spend integrity scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} signup-spend integrity scenarios passed`);
process.exit(0);
