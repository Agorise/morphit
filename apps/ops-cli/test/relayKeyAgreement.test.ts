/**
 * Who is believed when the relay's key is checked against the chain
 * (lib/relayKeyChain.ts), and how the relay's own verdict reaches `health` and
 * `status` (lib/relayActiveKey.ts) — review of v1.21.18, 2026-10-29:
 *
 *  - a refusing verdict ("not the active key", "no such account", "cannot sign
 *    alone") needs two RPC operators that agree: this node's indexer's
 *    /v1/account/<name>/keys, or two clearnet operators asked directly. One
 *    node's word (the only answer there was before) is "could not check",
 *    with what it said; "this is the key" may come from one;
 *  - a key that IS listed but whose weight is below the threshold gets its own
 *    verdict, instead of "not one of the active keys" next to that very key;
 *  - the relay's /v1/health block says no_account / bad_key and names the
 *    account, and each has its own fix — "no such account" is fixed in the env
 *    files, not with edit-active-key (which cannot set the account name).
 */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	checkKeyOnChain,
	describeKeyOnChain,
	judgeKeyOnChain,
	type KeyOnChain
} from '../src/lib/relayKeyChain.ts';
import {
	parseRelayActiveKey,
	relayKeyFix,
	relayKeyFoundAs,
	relayKeyMismatch
} from '../src/lib/relayActiveKey.ts';

const pub = (seed: string): string => PrivateKey.fromSeed(seed).createPublic('BLT').toString();
const ACTIVE = pub('rka-active');
const POSTING = pub('rka-posting');
const OTHER = pub('rka-other');

function account(
	active: unknown = { weight_threshold: 1, account_auths: [], key_auths: [[ACTIVE, 1]] }
) {
	return {
		name: 'relayacct',
		owner: { weight_threshold: 1, account_auths: [], key_auths: [[pub('rka-owner'), 1]] },
		active,
		posting: { weight_threshold: 1, account_auths: [], key_auths: [[POSTING, 1]] },
		memo_key: pub('rka-memo')
	};
}

const servers: http.Server[] = [];
let dir = '';
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'rka-'));
});
afterAll(() => {
	for (const s of servers) {
		s.closeAllConnections();
		s.close();
	}
	rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for this node's indexer: its two-operator keys read, and its
 *  one-node condenser relay. */
async function indexer(o: {
	keys: { status: number; body: unknown };
	oneNode: unknown[];
}): Promise<string> {
	const srv = http.createServer((req, res) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => {
			res.setHeader('content-type', 'application/json');
			if (req.url === '/v1/account/relayacct/keys') {
				res.statusCode = o.keys.status;
				return res.end(typeof o.keys.body === 'string' ? o.keys.body : JSON.stringify(o.keys.body));
			}
			if (req.url === '/v1/chain/condenser') return res.end(JSON.stringify({ result: o.oneNode }));
			res.statusCode = 404;
			res.end('404 Not Found');
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	servers.push(srv);
	return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

/** A Blurt node on its own loopback address (its own "operator"). */
async function node(host: string, accounts: unknown[]): Promise<string> {
	const srv = http.createServer((req, res) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => {
			const j = JSON.parse(b) as { id: number };
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: accounts }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, host, () => r()));
	servers.push(srv);
	return `http://${host}:${(srv.address() as { port: number }).port}`;
}

const DEAD = 'http://127.0.0.1:9';
const deps = (o: Record<string, unknown>) => ({
	hiddenOnly: () => false,
	healthStatePath: join(dir, `h-${Math.random()}.json`),
	clearnetEndpoints: [DEAD],
	...o
});

describe('a refusing verdict needs two operators', () => {
	it("the indexer's agreed read naming the posting key: ✗ wrong (posting)", async () => {
		const base = await indexer({
			keys: { status: 200, body: { account: account() } },
			oneNode: []
		});
		const v = await checkKeyOnChain('relayacct', POSTING, deps({ indexerBases: [base] }));
		expect(v).toMatchObject({ kind: 'wrong', foundAs: 'posting' });
	});

	it('the operators agreeing there is no such account (its 404 says so): no-account', async () => {
		const base = await indexer({
			keys: { status: 404, body: { code: 'not_found', message: 'no such account on chain' } },
			oneNode: []
		});
		expect(await checkKeyOnChain('relayacct', ACTIVE, deps({ indexerBases: [base] }))).toEqual({
			kind: 'no-account'
		});
	});

	it('one node only (the operators did not agree yet) saying "posting key": not trusted — unknown, with what it said', async () => {
		const base = await indexer({
			keys: { status: 502, body: { code: 'internal', message: 'did not agree' } },
			oneNode: [account()]
		});
		const v = await checkKeyOnChain('relayacct', POSTING, deps({ indexerBases: [base] }));
		expect(v.kind).toBe('unknown');
		const text = describeKeyOnChain(v, 'relayacct', POSTING).join('\n');
		expect(text).toMatch(/one Blurt node says that this is @relayacct's POSTING key/);
		expect(text).toMatch(/no second RPC operator could confirm it/);
	});

	it('one node saying "no such account" (an older indexer: a bare 404 is not its answer): not a refusal', async () => {
		const base = await indexer({ keys: { status: 404, body: '404 Not Found' }, oneNode: [] });
		const v = await checkKeyOnChain('relayacct', ACTIVE, deps({ indexerBases: [base] }));
		expect(v.kind).toBe('unknown');
		expect((v as { unconfirmed?: KeyOnChain }).unconfirmed).toEqual({ kind: 'no-account' });
	});

	it('one node saying "this is the key": ok (it can only let the operator go on)', async () => {
		const base = await indexer({ keys: { status: 502, body: {} }, oneNode: [account()] });
		expect(await checkKeyOnChain('relayacct', ACTIVE, deps({ indexerBases: [base] }))).toEqual({
			kind: 'active'
		});
	});

	it('indexer down: two clearnet operators agreeing decide; one alone does not', async () => {
		const a = await node('127.0.0.81', [account()]);
		const b = await node('127.0.0.82', [account()]);
		const two = await checkKeyOnChain(
			'relayacct',
			OTHER,
			deps({ indexerBases: [DEAD], clearnetEndpoints: [a, b] })
		);
		expect(two).toMatchObject({ kind: 'wrong', foundAs: null });
		const c = await node('127.0.0.83', [account()]);
		const one = await checkKeyOnChain(
			'relayacct',
			OTHER,
			deps({ indexerBases: [DEAD], clearnetEndpoints: [c, DEAD] })
		);
		expect(one.kind).toBe('unknown');
	}, 60_000);

	it('hidden-only: never asks clearnet nodes', async () => {
		const asked = vi.fn();
		const srv = http.createServer((_req, res) => {
			asked();
			res.end('{}');
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.84', () => r()));
		servers.push(srv);
		const base = await indexer({ keys: { status: 502, body: {} }, oneNode: [account()] });
		const v = await checkKeyOnChain(
			'relayacct',
			OTHER,
			deps({
				hiddenOnly: () => true,
				indexerBases: [base],
				clearnetEndpoints: [`http://127.0.0.84:${(srv.address() as { port: number }).port}`, DEAD]
			})
		);
		expect(v.kind).toBe('unknown');
		expect(asked).not.toHaveBeenCalled();
	});
});

describe('listed, but below the threshold', () => {
	it('its own verdict, with the weight and threshold — not "not one of the active keys"', () => {
		const v = judgeKeyOnChain(
			ACTIVE,
			[
				account({
					weight_threshold: 2,
					account_auths: [],
					key_auths: [
						[ACTIVE, 1],
						[OTHER, 1]
					]
				})
			],
			'relayacct'
		);
		expect(v).toEqual({ kind: 'weak', weight: 1, threshold: 2 });
		const text = describeKeyOnChain(v, 'relayacct', ACTIVE).join('\n');
		expect(text).toMatch(/Listed, but cannot sign alone/);
		expect(text).toMatch(/weight 1, below the threshold 2/);
		expect(text).not.toMatch(/is not one of/);
	});
});

describe("the relay's verdict, as health and status read it", () => {
	/** The relay's own guard, imported by a computed path: the relay's module
	 *  aliases ($log, …) are not in this workspace's type-check. */
	interface Guard {
		check(): Promise<unknown>;
		status(): Record<string, unknown>;
	}
	async function relaySays(lookup: () => Promise<unknown>, publicKey: string | null = ACTIVE) {
		const GUARD = join(
			import.meta.dirname,
			'..',
			'..',
			'relay',
			'src',
			'policy',
			'activeKeyGuard.ts'
		);
		const { ActiveKeyGuard } = (await import(GUARD)) as {
			ActiveKeyGuard: new (o: Record<string, unknown>) => Guard;
		};
		const g = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey,
			lookup,
			log: { info: () => {}, warn: () => {}, error: () => {} }
		});
		await g.check();
		// Through JSON, as /v1/health carries it.
		return parseRelayActiveKey(JSON.parse(JSON.stringify({ active_key: g.status() })))!;
	}

	it('"no such account": its own words and fix — the env files, not edit-active-key', async () => {
		const k = await relaySays(async () => ({ absent: true }));
		expect(k).toMatchObject({ state: 'mismatch', noAccount: true, account: 'relayacct' });
		expect(relayKeyMismatch(k)).toMatch(/@relayacct does not exist on the Blurt chain/);
		const fix = relayKeyFix(k).join('\n');
		expect(fix).toContain('sudo nano /etc/morphit/relay.env and /opt/morphit/morphit.env');
		expect(fix).toContain('MORPHIT_RELAY_ACCOUNT=');
		expect(fix).toContain('sudo systemctl restart morphit-relay');
		expect(fix).not.toContain('edit-active-key');
		expect(fix).not.toMatch(/morphit-ops edit\b/);
	});

	it('a key file with no valid key: says so, and the fix is a new key', async () => {
		const k = await relaySays(async () => null, null);
		expect(k).toMatchObject({ state: 'mismatch', badKey: true });
		expect(relayKeyMismatch(k)).toMatch(/does not hold a valid Blurt private key/);
		expect(relayKeyFix(k).join('\n')).toContain('sudo morphit-ops edit-active-key');
	});

	it('below the threshold: the weight and threshold, and the fix', async () => {
		const k = await relaySays(async () => ({
			active: [OTHER],
			owner: [],
			posting: [],
			memo: null,
			delegated: false,
			activeListed: [
				[ACTIVE, 1],
				[OTHER, 2]
			],
			activeThreshold: 2
		}));
		expect(k.belowThreshold).toEqual({ weight: 1, threshold: 2 });
		expect(relayKeyFoundAs(k)).toMatch(/weight 1, below the threshold 2/);
		expect(relayKeyFix(k).join('\n')).toMatch(/give this key weight 2/);
	});
});
