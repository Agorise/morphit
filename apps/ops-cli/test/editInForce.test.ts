/**
 * `morphit-ops edit` starts every question from the value the services RUN
 * with — every file they read, in their order, the last one wins — and writes
 * only what the operator changed.
 *
 * Review v1.21.18: on a server set up with Ansible the Blurt node list lives in
 * /etc/morphit/indexer.env (read after morphit.config.env). `edit` read only
 * morphit.env, showed "(unset)", offered the shipped list, and Enter wrote it —
 * then DELETED the operator's own list from indexer.env. The listing fee's
 * "press Enter to keep" wrote ops-cli's own fallback price (0.002, the indexer
 * runs with 0.001) and, with live prices, Enter took new amounts.
 *
 * The real runEdit (and the real RPC step) against scratch files under
 * MORPHIT_ENV_ROOT shaped like an Ansible server; prompts answer from a script
 * ('' = Enter, the question's own default), the restart offer, the register
 * broadcast, the on-chain tag lookup, the reachability probe and the price
 * fetch are stubbed — the price fetch SUCCEEDS here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

type Answer = string | RegExp;
let answers: Answer[] = [];
/** When the script runs out: answer Enter (up to a bound), or stop. */
let enterWhenOut = false;
const asked: Array<{ kind: string; q: string; def: unknown }> = [];
const offered: string[][] = [];

const next = (kind: string, q: string, def: unknown): Answer => {
	asked.push({ kind, q, def });
	if (asked.length > 300) throw new Error('more than 300 questions — a loop?');
	if (answers.length === 0) {
		if (enterWhenOut) return '';
		throw new Error(`no answer scripted for ${kind}: ${q}`);
	}
	return answers.shift()!;
};

vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		ask: vi.fn(async (q: string, d?: string) => {
			const a = next('ask', q, d);
			return a === '' ? (d ?? '') : String(a);
		}),
		askInt: vi.fn(async (q: string, o: { default?: number } = {}) => {
			const a = next('askInt', q, o.default);
			return a === '' ? o.default : Number(a);
		}),
		askFloat: vi.fn(async (q: string, o: { default?: number } = {}) => {
			const a = next('askFloat', q, o.default);
			return a === '' ? o.default : Number(a);
		}),
		askYesNo: vi.fn(async (q: string, d: boolean) => {
			const a = next('yesno', q, d);
			return a === '' ? d : /^y/i.test(String(a));
		}),
		askChoice: vi.fn(async (q: string, choices: readonly string[], d?: number) => {
			const a = next('choice', q, d);
			if (a === '') return d ?? 0;
			if (a instanceof RegExp) {
				const i = choices.findIndex((c) => a.test(c));
				if (i < 0) throw new Error(`no ${String(a)} in [${choices.join(' | ')}]`);
				return i;
			}
			return Number(a);
		})
	};
});
vi.mock('../src/lib/restartServices.ts', () => ({
	offerRestart: vi.fn(async (units: readonly string[]) => (offered.push([...units]), false))
}));
vi.mock('../src/commands/register.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, runRegister: vi.fn(async () => 0) };
});
vi.mock('../src/lib/operatorTagGuard.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, fetchRegisteredTag: vi.fn(async () => null) };
});
vi.mock('../src/init/chainCheck.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		probeRpcEndpoints: vi.fn(async (urls: readonly string[]) => ({
			results: urls.map((url) => ({ url, ok: true, latencyMs: 10, headBlock: 1 })),
			healthy: urls.length,
			total: urls.length,
			headBlock: 1
		}))
	};
});
vi.mock('../../indexer/src/lib/feeAmountCalc.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		// Live prices ARE available in this test.
		fetchBtcXmrPricesFromCoingecko: vi.fn(async () => ({ btcUsd: 100_000, xmrUsd: 400 }))
	};
});

const { runEdit } = await import('../src/commands/edit.ts');

const OWN_NODES = 'https://my-own-node.example,https://rpc.example.org';
let root = '';
let printed: string[] = [];
const saved = { ...process.env };
const live = (): string => join(root, 'opt/morphit');
const CFG = (): string => join(live(), 'morphit.config.env');
const ENV = (): string => join(live(), 'morphit.env');
const IDX = (): string => join(root, 'etc/morphit/indexer.env');
const RLY = (): string => join(root, 'etc/morphit/relay.env');
const text = (): string => printed.join('\n');
const edit = (out: string = live()): Promise<number> =>
	runEdit({ flags: { out }, positional: [] } as never);

/** Every file under the scratch root and its content. */
function snapshot(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string): void => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) walk(p);
			else out[relative(root, p)] = readFileSync(p, 'utf8');
		}
	};
	walk(root);
	return out;
}

/** A server set up with Ansible (ops/ansible/roles/morphit/templates): the
 *  node list and a copy of the tag in indexer.env, no listing-fee lines. */
function ansible(o: { relayFile?: boolean; indexerExtra?: string } = {}): void {
	writeFileSync(ENV(), 'MORPHIT_RELAY_ACCOUNT=example-relay\n');
	writeFileSync(
		CFG(),
		[
			'MORPHIT_INSTANCE_NAME="Example Node"',
			'MORPHIT_INSTANCE_ORIGIN=https://example-node.org',
			'MORPHIT_INSTANCE_OPERATOR_TAG=example-node.org',
			'MORPHIT_INSTANCE_CONTACT_URL="mailto:operator@example.org"',
			'MORPHIT_INDEXER_FEE_RECIPIENT=example-fees',
			''
		].join('\n')
	);
	writeFileSync(
		IDX(),
		`MORPHIT_INDEXER_LISTEN_PORT=8081\nMORPHIT_INDEXER_RPC_ENDPOINTS=${OWN_NODES}\nMORPHIT_INSTANCE_OPERATOR_TAG=example-node.org\n${o.indexerExtra ?? ''}`
	);
	if (o.relayFile === true)
		writeFileSync(RLY(), 'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS=http://example.onion:8091\n');
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'edit-in-force-'));
	mkdirSync(live(), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	answers = [];
	enterWhenOut = false;
	asked.length = 0;
	offered.length = 0;
	printed = [];
	process.env.MORPHIT_ENV_ROOT = root;
	delete process.env.MORPHIT_OPS_CALLER_CWD;
	for (const k of Object.keys(process.env))
		if (k.startsWith('MORPHIT_INSTANCE_')) delete process.env[k];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

describe('Blurt RPC endpoints on an Ansible server', () => {
	it('shows the list the indexer runs with (from indexer.env); Enter keeps it and touches nothing', async () => {
		ansible();
		const before = snapshot();
		answers = [/^Blurt RPC endpoints$/, ''];
		expect(await edit()).toBe(0);
		expect(asked.find((a) => /Blurt RPC endpoints/.test(a.q))?.def).toBe(OWN_NODES);
		expect(text()).toMatch(/Blurt RPC list:\s+https:\/\/my-own-node\.example \+1 more/);
		expect(text()).toMatch(/Nothing changed\./);
		expect(snapshot()).toEqual(before);
		expect(offered).toEqual([]);
	});

	it('a changed list: written for the indexer AND the relay, the old copy in indexer.env removed', async () => {
		ansible({ relayFile: true });
		answers = [/^Blurt RPC endpoints$/, 'https://rpc.example.org', '', 'y'];
		enterWhenOut = true;
		expect(await edit()).toBe(0);
		const env = readFileSync(ENV(), 'utf8');
		expect(env).toMatch(/^MORPHIT_INDEXER_RPC_ENDPOINTS=https:\/\/rpc\.example\.org$/m);
		expect(env).toMatch(/^MORPHIT_RELAY_BLURT_RPC=https:\/\/rpc\.example\.org$/m);
		expect(readFileSync(IDX(), 'utf8')).not.toMatch(/RPC_ENDPOINTS/);
		expect(readFileSync(IDX(), 'utf8')).toMatch(/OPERATOR_TAG=example-node\.org/);
		expect(offered[0]).toEqual(expect.arrayContaining(['morphit-indexer', 'morphit-relay']));
	});

	it('the relay already uses another list: said, and Enter leaves it as it is', async () => {
		ansible({ relayFile: true });
		const before = snapshot();
		answers = [/^Blurt RPC endpoints$/, ''];
		enterWhenOut = true;
		expect(await edit()).toBe(0);
		const q = asked.find((a) => /Give the relay the same list/.test(a.q));
		expect(q?.def).toBe(false);
		expect(text()).toMatch(/relay uses a different list/);
		expect(snapshot()).toEqual(before);
	});

	it('a hidden-only node (empty list in indexer.env): Enter is no change, not "(not set) → (empty)"', async () => {
		writeFileSync(ENV(), 'MORPHIT_RELAY_ACCOUNT=example-relay\n');
		writeFileSync(CFG(), "MORPHIT_INSTANCE_NAME='Example'\n");
		writeFileSync(IDX(), 'MORPHIT_INDEXER_LISTEN_PORT=8081\nMORPHIT_INDEXER_RPC_ENDPOINTS=\n');
		const before = snapshot();
		answers = [/^Blurt RPC endpoints$/, ''];
		expect(await edit()).toBe(0);
		expect(text()).toMatch(/Nothing changed\./);
		expect(text()).not.toMatch(/Review/);
		expect(snapshot()).toEqual(before);
	});
});

describe('"All of the above", Enter everywhere, on an Ansible server with live prices', () => {
	it('changes nothing: every file byte-identical, nothing restarted', async () => {
		ansible({ relayFile: true });
		const before = snapshot();
		answers = [/^All of the above$/];
		enterWhenOut = true;
		expect(await edit()).toBe(0);
		expect(text()).toMatch(/Nothing changed\./);
		expect(text()).not.toMatch(/^Review$/m);
		expect(snapshot()).toEqual(before);
		expect(offered).toEqual([]);
	});
});

describe('Listing fee: the values in force, and Enter keeps them', () => {
	it("no fee lines in the files: the indexer's own values are shown and kept (not ops-cli's 0.002)", async () => {
		ansible();
		const before = snapshot();
		answers = [/^Listing fee/];
		enterWhenOut = true;
		expect(await edit()).toBe(0);
		expect(asked.find((a) => /Fallback BLURT\/USD/.test(a.q))?.def).toBe(0.001);
		const keep = asked.find((a) => a.kind === 'choice' && /What would you like to do/.test(a.q));
		expect(keep?.def).toBe(0);
		expect(snapshot()).toEqual(before);
	});

	it('live prices available: Enter keeps the current amounts (new ones only when picked)', async () => {
		ansible();
		writeFileSync(
			CFG(),
			readFileSync(CFG(), 'utf8') +
				'MORPHIT_INDEXER_BTC_FEE_SATOSHIS=500\nMORPHIT_INDEXER_XMR_FEE_PICONERO=900000000\n'
		);
		const before = snapshot();
		answers = [/^Listing fee/];
		enterWhenOut = true;
		expect(await edit()).toBe(0);
		expect(snapshot()).toEqual(before);
		expect(asked.some((a) => /Accept these amounts|Use these new amounts/.test(a.q))).toBe(false);
	});

	it('picking "work out new amounts": the target your setup used is the default, the new amounts are written', async () => {
		ansible();
		writeFileSync(
			CFG(),
			readFileSync(CFG(), 'utf8') +
				'# Target was: $0.30 USD per fee\nMORPHIT_INDEXER_BTC_FEE_SATOSHIS=500\nMORPHIT_INDEXER_XMR_FEE_PICONERO=900000000\n'
		);
		answers = [/^Listing fee/, /Work out new amounts/, '', '', '', '', 'y', 'n'];
		expect(await edit()).toBe(0);
		expect(asked.find((a) => /USD target/.test(a.q))?.def).toBe(0.3);
		expect(text()).toMatch(/The target your setup used: \$0\.30 USD/);
		// $0.30 at $100,000 BTC = 300 sat; the fallback price was not changed.
		const cfg = readFileSync(CFG(), 'utf8');
		expect(cfg).toMatch(/^MORPHIT_INDEXER_BTC_FEE_SATOSHIS=300$/m);
		expect(cfg).not.toMatch(/STATIC_FLOOR/);
	});
});

describe('a setting set again in a file read later', () => {
	it('is shown as in force, and kept there when another setting is changed', async () => {
		ansible({ indexerExtra: "MORPHIT_INSTANCE_NAME='Old Copy'\n" });
		answers = [/^Branding & SEO$/, '', '', 'A new tagline', '', '', '', '', 'y', 'n'];
		enterWhenOut = true;
		expect(await edit()).toBe(0);
		expect(text()).toMatch(/Instance name:\s+Old Copy/);
		expect(readFileSync(CFG(), 'utf8')).toMatch(/^MORPHIT_INSTANCE_TAGLINE='A new tagline'$/m);
		// The operator did not change the name: indexer.env keeps it.
		expect(readFileSync(IDX(), 'utf8')).toMatch(/^MORPHIT_INSTANCE_NAME='Old Copy'$/m);
	});
});

describe('Tor address on a node with no public web address', () => {
	it('"-" asks first (default No): Enter keeps it', async () => {
		const onion = `${'a'.repeat(56)}.onion`;
		writeFileSync(ENV(), 'MORPHIT_RELAY_ACCOUNT=example-relay\n');
		writeFileSync(CFG(), `MORPHIT_INSTANCE_NAME=Site\nMORPHIT_INSTANCE_TOR_ADDRESS=${onion}\n`);
		const before = snapshot();
		answers = [/^Alt-network addresses$/, '-', ''];
		enterWhenOut = true;
		expect(await edit()).toBe(0);
		const q = asked.find((a) => a.kind === 'yesno' && /remove your tor \.onion address/i.test(a.q));
		expect(q?.def).toBe(false);
		expect(snapshot()).toEqual(before);
	});
});

describe('--out given as a relative path', () => {
	it('is relative to where the operator ran the command (MORPHIT_OPS_CALLER_CWD)', async () => {
		const callerDir = join(root, 'home/alice');
		mkdirSync(join(callerDir, 'site'), { recursive: true });
		writeFileSync(join(callerDir, 'site', 'morphit.config.env'), 'MORPHIT_INSTANCE_NAME=Site\n');
		process.env.MORPHIT_OPS_CALLER_CWD = callerDir;
		answers = [/^Cancel$/];
		expect(await edit('site')).toBe(0);
		expect(text()).toContain(`Loaded ${join(callerDir, 'site', 'morphit.config.env')}`);
	});
});

describe('settings with nothing set', () => {
	it('Fees account: none set (fees go to the treasury) — Enter leaves it so; nothing written', async () => {
		ansible();
		writeFileSync(
			CFG(),
			readFileSync(CFG(), 'utf8').replace(/^MORPHIT_INDEXER_FEE_RECIPIENT=.*\n/m, '')
		);
		const before = snapshot();
		answers = [/^Fees account/, ''];
		expect(await edit()).toBe(0);
		expect(text()).toMatch(
			/leave it as it is — none is set, so the fees go to the Morphit treasury/
		);
		expect(text()).toMatch(/Nothing changed\./);
		expect(snapshot()).toEqual(before);
	});

	it('Operator tag: none set and none registered — Enter leaves it unset (no placeholder tag put in)', async () => {
		writeFileSync(ENV(), 'MORPHIT_RELAY_ACCOUNT=example-relay\n');
		writeFileSync(CFG(), "MORPHIT_INSTANCE_NAME='Example'\n");
		const before = snapshot();
		answers = [/^Operator tag/, ''];
		expect(await edit()).toBe(0);
		expect(asked.find((a) => /Operator tag/.test(a.q))?.def).toBeUndefined();
		expect(text()).toMatch(/Nothing changed\./);
		expect(snapshot()).toEqual(before);
	});
});
