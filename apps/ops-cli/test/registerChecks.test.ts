/**
 * `register` (menu: "Re-publish my registration on-chain") and its error
 * advice, against a stand-in for this node's own indexer listening where
 * indexer.env says (not the default port):
 *
 *  - the saved key is checked against the chain before anything is signed:
 *    the wrong key is refused with ✗ and the fix, nothing broadcast (M8);
 *  - the existing registration is read from the indexer's configured address
 *    (localIndexerBases), so a tag conflict is caught (LOW: fetchRegisteredTag
 *    asked only 127.0.0.1:8081);
 *  - re-publishing exactly what the chain holds says so and asks, default No
 *    (LOW);
 *  - a broadcast that did not answer in time says it may still land and looks
 *    for it (M3); "timed out" is a connectivity failure (M3);
 *  - tag advice names the operator tag, key advice names edit-active-key (M4);
 *  - missing settings are named one by one with the command that sets them
 *    (M5);
 *  - a "wrong key" or "no such account" verdict refuses only when two RPC
 *    operators agree (the indexer's /v1/account/<name>/keys); one node's word
 *    is "could not check", and register goes on (review, 2026-10-29);
 *  - a broadcast that came back with "no final answer" (it may have reached a
 *    node) is looked for, end to end, like register's own timeout.
 */
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const broadcasts: Array<Record<string, unknown>> = [];
let hangBroadcast = false;
/** The broadcast ends with "no final answer" (it may have reached a node). */
let unknownOutcome: (() => void) | null = null;
vi.mock('../src/commands/chainErrors.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	const { BroadcastOutcomeUnknownError } = await import('../src/lib/chainAccess.ts');
	return {
		...real,
		broadcastCustomJson: vi.fn(async (a: { payload: Record<string, unknown> }) => {
			if (hangBroadcast) return new Promise(() => {});
			broadcasts.push(a.payload);
			if (unknownOutcome !== null) {
				unknownOutcome();
				throw new BroadcastOutcomeUnknownError('e'.repeat(40), 'test: no answer in time');
			}
			return { trx_id: 'f'.repeat(40) };
		})
	};
});
const asked: Array<[string, boolean]> = [];
const answers: Array<[RegExp, boolean]> = [];
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askYesNo: async (q: string, def: boolean) => {
		asked.push([q, def]);
		const hit = answers.find(([re]) => re.test(q));
		return hit ? hit[1] : def;
	}
}));

const ACTIVE_WIF = PrivateKey.fromSeed('reg-active').toString();
const POSTING_WIF = PrivateKey.fromSeed('reg-posting').toString();
const pub = (w: string): string => PrivateKey.fromString(w).createPublic('BLT').toString();

/** What the stand-in indexer says. `keys`: its two-operator account read —
 *  'agreed' (the account), 'absent' (they agree it does not exist),
 *  'undecided' (502: the operators did not agree yet). */
const idx = {
	tag: null as string | null,
	payload: null as Record<string, unknown> | null,
	keys: 'agreed' as 'agreed' | 'absent' | 'undecided',
	/** What its one-node condenser relay answers for get_accounts. */
	oneNodeAbsent: false
};
function chainAccount() {
	return {
		name: 'relayacct',
		owner: { weight_threshold: 1, account_auths: [], key_auths: [['BLTowner', 1]] },
		active: {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[pub(ACTIVE_WIF), 1]]
		},
		posting: {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[pub(POSTING_WIF), 1]]
		},
		memo_key: 'BLTmemo'
	};
}
let server: http.Server;
let port = 0;
let root = '';
let out = '';

beforeAll(async () => {
	server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			res.setHeader('content-type', 'application/json');
			if (req.url === '/v1/operators') {
				return res.end(
					JSON.stringify({
						operators: idx.tag
							? [
									{
										account: 'relayacct',
										tag: idx.tag,
										display_name: 'Alice Exchange',
										contact_url: null
									}
								]
							: []
					})
				);
			}
			if (req.url === '/v1/operator-registration/relayacct') {
				return idx.payload
					? res.end(JSON.stringify({ payload: idx.payload }))
					: ((res.statusCode = 404),
						res.end(JSON.stringify({ message: 'no applied registration' })));
			}
			if (req.url === '/v1/account/relayacct/keys') {
				if (idx.keys === 'undecided') {
					res.statusCode = 502;
					return res.end(
						JSON.stringify({
							code: 'internal',
							message: 'Blurt RPC operators did not agree on this account yet'
						})
					);
				}
				if (idx.keys === 'absent') {
					res.statusCode = 404;
					return res.end(
						JSON.stringify({ code: 'not_found', message: 'no such account on chain' })
					);
				}
				return res.end(JSON.stringify({ account: chainAccount() }));
			}
			if (req.url === '/v1/chain/condenser') {
				const j = JSON.parse(body) as { method: string };
				if (j.method === 'get_accounts')
					return res.end(JSON.stringify({ result: idx.oneNodeAbsent ? [] : [chainAccount()] }));
			}
			res.statusCode = 404;
			res.end('{}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	port = (server.address() as { port: number }).port;
});
afterAll(() => {
	server.close();
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'reg-chk-'));
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	// The indexer listens on a port of its own; the clearnet pool is set (not
	// hidden-only) but never reached: the indexer answers first.
	writeFileSync(
		join(root, 'etc', 'morphit', 'indexer.env'),
		`MORPHIT_INDEXER_LISTEN_HOST=127.0.0.1\nMORPHIT_INDEXER_LISTEN_PORT=${port}\nMORPHIT_INDEXER_RPC_ENDPOINTS=http://127.0.0.1:9\n`
	);
	vi.stubEnv('MORPHIT_ENV_ROOT', root);
	vi.stubEnv('MORPHIT_RELAY_CRED_FILE', join(root, 'none.cred'));
	vi.stubEnv('MORPHIT_RPC_HEALTH_STATE', join(root, 'h.json'));
	vi.stubEnv('MORPHIT_RELAY_ACCOUNT', 'relayacct');
	vi.stubEnv('MORPHIT_INSTANCE_NAME', 'Alice Exchange');
	vi.stubEnv('MORPHIT_INSTANCE_ORIGIN', 'https://alice.example.org');
	vi.stubEnv('MORPHIT_INSTANCE_OPERATOR_TAG', 'alice.example.org');
	vi.stubEnv('MORPHIT_INDEXER_FEE_RECIPIENT', 'alice-fees');
	broadcasts.length = 0;
	asked.length = 0;
	answers.length = 0;
	idx.tag = null;
	idx.payload = null;
	idx.keys = 'agreed';
	idx.oneNodeAbsent = false;
	hangBroadcast = false;
	unknownOutcome = null;
	out = '';
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += a.join(' ') + '\n';
	});
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function keyFile(wif: string): string {
	const p = join(root, 'keystore.wif');
	writeFileSync(p, wif);
	vi.stubEnv('MORPHIT_RELAY_ACTIVE_KEY_FILE', p);
	return p;
}

const { runRegister, broadcastRegistration, registrationLanded, RegisterTimeoutError } =
	await import('../src/commands/register.ts');

describe('register checks the saved key against the chain', () => {
	it('the posting key: ✗ with the fix, and nothing is broadcast', async () => {
		keyFile(POSTING_WIF);
		answers.push([/^Publish this registration/, true]);
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(rc).toBe(1);
		expect(out).toMatch(/✗ Does not match/);
		expect(out).toMatch(/POSTING key/);
		expect(out).toContain('sudo morphit-ops edit-active-key');
		expect(out).not.toMatch(/blocks\.blurtwallet\.com|block explorer/);
		expect(broadcasts).toEqual([]);
	});

	it('one node saying "posting key", with no two operators agreeing: not trusted — "could not check", and it is published', async () => {
		keyFile(POSTING_WIF);
		idx.keys = 'undecided';
		answers.push([/^Publish this registration/, true]);
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(out).toMatch(/\? Could not check it against the chain: one Blurt node says/);
		expect(out).not.toMatch(/✗ Does not match/);
		expect(broadcasts).toHaveLength(1);
		expect(rc).toBe(0);
	});

	it('one node saying "no such account" (a node still replaying the chain): not a refusal', async () => {
		keyFile(ACTIVE_WIF);
		idx.keys = 'undecided';
		idx.oneNodeAbsent = true;
		answers.push([/^Publish this registration/, true]);
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(out).not.toMatch(/does not exist on the Blurt chain/);
		expect(broadcasts).toHaveLength(1);
		expect(rc).toBe(0);
	});

	it('two operators agreeing there is no such account: refused, nothing broadcast', async () => {
		keyFile(ACTIVE_WIF);
		idx.keys = 'absent';
		answers.push([/^Publish this registration/, true]);
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(rc).toBe(1);
		expect(out).toMatch(/✗ The account @relayacct does not exist on the Blurt chain/);
		expect(broadcasts).toEqual([]);
	});

	it('the active key: ✓ matches, and it is published', async () => {
		keyFile(ACTIVE_WIF);
		answers.push([/^Publish this registration/, true]);
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(rc).toBe(0);
		expect(out).toMatch(/✓ Matches: this is @relayacct's ACTIVE key/);
		expect(broadcasts).toHaveLength(1);
	});
});

describe("register reads the existing registration from the indexer's own address", () => {
	it('a different registered tag is caught before anything is asked or sent', async () => {
		keyFile(ACTIVE_WIF);
		idx.tag = 'alice-old-tag';
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(rc).toBe(1);
		expect(out).toMatch(/already registered under the tag "alice-old-tag"/);
		expect(broadcasts).toEqual([]);
	});

	it('the same registration as on chain: says so, asks (default No), and publishes nothing', async () => {
		keyFile(ACTIVE_WIF);
		idx.tag = 'alice.example.org';
		idx.payload = {
			v: 1,
			tag: 'alice.example.org',
			display_name: 'Alice Exchange',
			origin: 'https://alice.example.org',
			fee_recipient: 'alice-fees'
		};
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(rc).toBe(0);
		expect(out).toMatch(/already says exactly this/);
		const q = asked.find(([text]) => /Publish it again anyway/.test(text));
		expect(q?.[1]).toBe(false);
		expect(broadcasts).toEqual([]);
	});
});

describe('a broadcast that did not answer in time', () => {
	it('never claims the registration is unchanged — it may still land', async () => {
		hangBroadcast = true;
		await expect(broadcastRegistration('relayacct', ACTIVE_WIF, { v: 1 }, 300)).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof RegisterTimeoutError &&
				!/unchanged/.test(e.message) &&
				/can still land/.test(e.message)
		);
	});

	it('end to end: "no final answer" from the broadcast is looked for, and found — exit 0, not "could not complete"', async () => {
		keyFile(ACTIVE_WIF);
		answers.push([/^Publish this registration/, true]);
		// The registration shows up on the indexer right after the broadcast.
		unknownOutcome = () => {
			idx.tag = 'alice.example.org';
			idx.payload = {
				v: 1,
				tag: 'alice.example.org',
				display_name: 'Alice Exchange',
				origin: 'https://alice.example.org',
				fee_recipient: 'alice-fees'
			};
		};
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(broadcasts).toHaveLength(1);
		expect(out).toMatch(/may already have reached the Blurt network, so it can still land/);
		expect(out).toMatch(
			/✓ Your registration on the chain now matches what was sent — it is published/
		);
		expect(out).not.toMatch(/Could not complete the broadcast/);
		expect(rc).toBe(0);
	});

	it("the watch covers the transaction's life plus the time until its block is final (~45 s) and the indexer's read", async () => {
		// Signed at t=0, taken at its last moment (t≈60 s), final ≈45 s later,
		// read by the indexer a few seconds after: it shows up at t≈110 s.
		vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
		try {
			const payload = { v: 1, tag: 'alice.example.org', display_name: 'Alice Exchange' };
			const start = Date.now();
			const p = registrationLanded('relayacct', payload, {
				local: async () =>
					Date.now() - start >= 110_000
						? {
								state: 'registered',
								tag: 'alice.example.org',
								displayName: 'Alice Exchange',
								contactUrl: null
							}
						: { state: 'not_registered' },
				accepted: async () => ({ state: 'ok', payload, source: 'test' })
			});
			await vi.advanceTimersByTimeAsync(140_000);
			expect(await p).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('is found when the indexer then shows it', async () => {
		const payload = {
			v: 1,
			tag: 'alice.example.org',
			display_name: 'Alice Exchange',
			fee_recipient: 'alice-fees'
		};
		let calls = 0;
		const landed = await registrationLanded('relayacct', payload, {
			local: async () =>
				++calls < 2
					? { state: 'not_registered' }
					: {
							state: 'registered',
							tag: 'alice.example.org',
							displayName: 'Alice Exchange',
							contactUrl: null
						},
			accepted: async () => ({ state: 'ok', payload, source: 'test' }),
			watchMs: 5_000,
			pollMs: 10
		});
		expect(landed).toBe(true);
	});

	it('"timed out" is a connectivity failure, not an unknown one', async () => {
		const { classifyChainError } = await import('../src/commands/chainErrors.ts');
		expect(
			classifyChainError(
				'Timed out reaching a Blurt RPC after 15s — this box may not be online yet.'
			)
		).toBe('rpc_unreachable');
	});
});

describe('the advice after a rejected broadcast', () => {
	async function help(raw: string, nameEnvVar: string): Promise<string> {
		const { printChainErrorHelp } = await import('../src/commands/chainErrors.ts');
		const lines: string[] = [];
		printChainErrorHelp(
			raw,
			{ opLabel: 'x', account: 'relayacct', tag: 'alice.example.org', keyFile: '/k', nameEnvVar },
			(l) => lines.push(l)
		);
		return lines.join('\n');
	}
	it('a taken or reserved tag: change the OPERATOR TAG (what register publishes), not the instance name', async () => {
		for (const raw of ['assert_exception: tag_taken', 'assert_exception: tag_reserved']) {
			const t = await help(raw, 'MORPHIT_INSTANCE_NAME');
			expect(t).toMatch(/sudo morphit-ops edit {2}→ Operator tag/);
			expect(t).toContain('MORPHIT_INSTANCE_OPERATOR_TAG');
			expect(t).not.toContain('MORPHIT_INSTANCE_NAME');
		}
	});
	it('the wrong key: sudo morphit-ops edit-active-key (not `edit`)', async () => {
		const t = await help('missing required posting authority', 'MORPHIT_INSTANCE_OPERATOR_TAG');
		expect(t).toContain('sudo morphit-ops edit-active-key');
		expect(t).not.toMatch(/morphit-ops\s+edit`|`sudo morphit-ops\s*$/m);
	});
});

describe('register with settings missing', () => {
	it('names each one, where it lives and the command that sets it — no "source the files"', async () => {
		keyFile(ACTIVE_WIF);
		vi.stubEnv('MORPHIT_INSTANCE_NAME', '');
		vi.stubEnv('MORPHIT_INSTANCE_ORIGIN', '');
		const rc = await runRegister({ flags: {}, positional: [] });
		expect(rc).toBe(1);
		expect(out).toMatch(/display name \(MORPHIT_INSTANCE_NAME/);
		expect(out).toContain('sudo morphit-ops edit  → Branding & SEO');
		expect(out).toMatch(/public address \(MORPHIT_INSTANCE_ORIGIN/);
		expect(out).toContain('sudo morphit-ops edit  → Primary origin');
		expect(out).not.toMatch(/set -a|\. \.\/morphit\.env|source/);
	});
});
