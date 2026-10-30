/**
 * `morphit-ops edit` never changes a setting the operator did not change.
 *
 * The real runEdit against scratch settings files under MORPHIT_ENV_ROOT; the
 * prompts answer from a script ('' = press Enter), the restart, the register
 * broadcast, the on-chain tag lookup and the price fetch are stubbed. What is
 * observed: the file on disk, what was offered, what was printed.
 *
 *  - Primary origin: Enter keeps it ("leave blank to skip" used to DELETE it,
 *    restart the services and offer a doomed re-register); "-" removes it only
 *    after a yes; with no name or address left, no re-register is offered —
 *    the operator is told exactly what to set.
 *  - Operator tag: Enter keeps the registered tag (it defaulted to the domain,
 *    silently replacing a permanent tag), and a different one is refused.
 *  - Nothing changed → "Nothing changed.", no restart.
 *  - Listing fee: every question starts from the configured value (the amounts
 *    are kept unless new ones are asked for), the display unit is saved, and a
 *    hidden-only node never asks Coingecko. (Settings in force from other
 *    files, and live prices: test/editInForce.test.ts.)
 *  - "All of the above" really runs every section (RPC too); the menu is
 *    printed once; Review uses plain names and one rule line; the permissions
 *    line says the file's real mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Answer = string | RegExp;
let answers: Answer[] = [];
const asked: Array<{ kind: string; q: string; def: unknown }> = [];
const offered: string[][] = [];
let registerRuns = 0;
let registeredTag: string | null = null;
let priceFetches = 0;
let rpcCalls = 0;

const next = (kind: string, q: string, def: unknown): Answer => {
	asked.push({ kind, q, def });
	if (answers.length === 0) throw new Error(`no answer scripted for ${kind}: ${q}`);
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
	return { ...real, runRegister: vi.fn(async () => (registerRuns++, 0)) };
});
vi.mock('../src/lib/operatorTagGuard.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, fetchRegisteredTag: vi.fn(async () => registeredTag) };
});
vi.mock('../../indexer/src/lib/feeAmountCalc.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		fetchBtcXmrPricesFromCoingecko: vi.fn(async () => {
			priceFetches++;
			throw new Error('no network in this test');
		})
	};
});
vi.mock('../src/init/steps.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		stepRpcEndpoints: vi.fn(async (cur: readonly string[] | null) => (rpcCalls++, cur ?? []))
	};
});

const { runEdit } = await import('../src/commands/edit.ts');

const ONION = `${'a'.repeat(56)}.onion`;
const BASE = [
	'MORPHIT_INSTANCE_ORIGIN=https://example-node.org',
	"MORPHIT_INSTANCE_NAME='Example Node'",
	'MORPHIT_INSTANCE_OPERATOR_TAG=my-custom-tag',
	'MORPHIT_INDEXER_BTC_FEE_SATOSHIS=500',
	'MORPHIT_INDEXER_XMR_FEE_PICONERO=900000000',
	'MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR=0.004',
	'MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT=EUR',
	'MORPHIT_INDEXER_FEE_RECIPIENT=example-fees',
	''
].join('\n');

let root = '';
let printed: string[] = [];
const saved = { ...process.env };
const live = (): string => join(root, 'opt/morphit');
const cfg = (): string => join(live(), 'morphit.config.env');
const text = (): string => printed.join('\n');
const edit = (): Promise<number> => runEdit({ flags: { out: live() }, positional: [] } as never);

function setup(config: string, opts: { hiddenOnly?: boolean } = {}): void {
	writeFileSync(cfg(), config);
	writeFileSync(
		join(live(), 'morphit.env'),
		"MORPHIT_RELAY_ACCOUNT=example-relay\nMORPHIT_INDEXER_RPC_ENDPOINTS='https://rpc.example.org'\n"
	);
	writeFileSync(
		join(root, 'etc/morphit/indexer.env'),
		opts.hiddenOnly ? 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n' : 'MORPHIT_INDEXER_LISTEN_PORT=8081\n'
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'edit-keeps-'));
	mkdirSync(live(), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	answers = [];
	asked.length = 0;
	offered.length = 0;
	registerRuns = 0;
	registeredTag = null;
	priceFetches = 0;
	rpcCalls = 0;
	printed = [];
	process.env.MORPHIT_ENV_ROOT = root;
	delete process.env.MORPHIT_INSTANCE_ORIGIN;
	delete process.env.MORPHIT_INSTANCE_NAME;
	delete process.env.MORPHIT_INSTANCE_TOR_ADDRESS;
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

describe('edit → Primary origin', () => {
	it('Enter keeps the origin: the file is untouched, nothing is restarted', async () => {
		setup(BASE);
		answers = [/^Primary origin$/, ''];
		expect(await edit()).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toBe(BASE);
		expect(offered).toEqual([]);
		expect(registerRuns).toBe(0);
		expect(text()).toMatch(/Nothing changed\./);
		expect(text()).not.toMatch(/You changed your origin/);
	});

	it('"-" removes it only after a yes; the default answer keeps it', async () => {
		setup(BASE);
		answers = [/^Primary origin$/, '-', ''];
		expect(await edit()).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toBe(BASE);
		const q = asked.find((a) => a.kind === 'yesno' && /remove your public origin/i.test(a.q));
		expect(q?.def).toBe(false);
	});

	it('removed with no Tor address left: no re-register is offered, and it says what to set', async () => {
		setup(BASE);
		answers = [/^Primary origin$/, '-', 'y', 'y'];
		expect(await edit()).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).not.toMatch(/MORPHIT_INSTANCE_ORIGIN/);
		expect(asked.some((a) => /broadcast this change/i.test(a.q))).toBe(false);
		expect(registerRuns).toBe(0);
		expect(text()).toMatch(/cannot be re-published yet/);
		expect(text()).toMatch(/no public web address \(Primary origin\)/);
	});

	it('a new origin is written and the re-publish offered', async () => {
		setup(BASE);
		answers = [/^Primary origin$/, 'https://new-node.example', 'y', 'y'];
		expect(await edit()).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toMatch(
			/^MORPHIT_INSTANCE_ORIGIN=https:\/\/new-node\.example$/m
		);
		expect(registerRuns).toBe(1);
	});
});

describe('edit → Branding: removing the name', () => {
	it('asks first (default No); once removed, no re-register is offered, and it says what to set', async () => {
		setup(BASE + `MORPHIT_INSTANCE_TOR_ADDRESS=${ONION}\n`);
		answers = [/^Branding & SEO$/, '-', 'y', '', '', '', '', '', '', 'y'];
		expect(await edit()).toBe(0);
		const q = asked.find((a) => a.kind === 'yesno' && /remove your instance name/i.test(a.q));
		expect(q?.def).toBe(false);
		expect(readFileSync(cfg(), 'utf8')).not.toMatch(/MORPHIT_INSTANCE_NAME/);
		expect(registerRuns).toBe(0);
		expect(text()).toMatch(/no instance name/);
	});
});

describe('edit → Operator tag', () => {
	it('Enter keeps the registered tag, never the domain', async () => {
		setup(BASE);
		registeredTag = 'my-custom-tag';
		answers = [/^Operator tag/, ''];
		expect(await edit()).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toBe(BASE);
		expect(asked.find((a) => /Operator tag/.test(a.q))?.def).toBe('my-custom-tag');
		expect(offered).toEqual([]);
	});

	it('not registered (or not known): Enter keeps the one set now, not the domain', async () => {
		setup(BASE);
		answers = [/^Operator tag/, ''];
		expect(await edit()).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toBe(BASE);
	});

	it('a different tag than the registered one is refused; a drifted setting goes back to it', async () => {
		setup(BASE.replace('my-custom-tag', 'drifted-tag'));
		registeredTag = 'my-custom-tag';
		answers = [/^Operator tag/, 'another-tag', '', 'y', 'n'];
		expect(await edit()).toBe(0);
		expect(text()).toMatch(/registered with the tag "my-custom-tag".*can never change/s);
		expect(readFileSync(cfg(), 'utf8')).toMatch(/^MORPHIT_INSTANCE_OPERATOR_TAG=my-custom-tag$/m);
	});
});

describe('edit → Listing fee', () => {
	it('every question starts from the configured value; Enter everywhere changes nothing', async () => {
		setup(BASE);
		answers = [/^Listing fee/, '', '', ''];
		expect(await edit()).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toBe(BASE);
		expect(text()).toMatch(/Nothing changed\./);
		expect(offered).toEqual([]);
		expect(asked.find((a) => /Fallback BLURT\/USD/.test(a.q))?.def).toBe(0.004);
		const keep = asked.find((a) => a.kind === 'choice' && /What would you like to do/.test(a.q));
		expect(keep?.def).toBe(0);
		const { askChoice } = await import('../src/init/prompt.ts');
		const keepCall = vi
			.mocked(askChoice)
			.mock.calls.find((c) => /What would you like to do/.test(String(c[0])));
		expect(keepCall?.[1][0]).toMatch(
			/Keep your current amounts \(500 satoshis, 900,000,000 piconero\)/
		);
		// The display unit offered as the default is the configured one.
		const unit = asked.find((a) => a.kind === 'choice' && /display prices in/.test(a.q));
		expect(unit?.def).toBe(1); // EUR
	});

	it('the display unit chosen is saved', async () => {
		setup(BASE);
		// Keep the amounts (Enter), keep the fallback price (Enter), GBP, apply.
		answers = [/^Listing fee/, '', '', /^GBP/, 'y', 'n'];
		expect(await edit()).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toMatch(
			/^MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT=GBP$/m
		);
		expect(readFileSync(cfg(), 'utf8')).toMatch(/^MORPHIT_INDEXER_BTC_FEE_SATOSHIS=500$/m);
	});

	it('a hidden-only node never asks Coingecko', async () => {
		setup(BASE, { hiddenOnly: true });
		answers = [/^Listing fee/, '', '', ''];
		expect(await edit()).toBe(0);
		expect(priceFetches).toBe(0);
		expect(text()).toMatch(/hidden-only, so live BTC\/XMR prices are not fetched/);
	});

	it('the USD label is not marked "(default)" twice', async () => {
		setup(BASE.replace('DENOMINATION_FIAT=EUR', 'DENOMINATION_FIAT=USD'));
		answers = [/^Listing fee/, '', '', ''];
		const { askChoice } = await import('../src/init/prompt.ts');
		expect(await edit()).toBe(0);
		const call = vi
			.mocked(askChoice)
			.mock.calls.find((c) => /display prices in/.test(String(c[0])));
		expect(call?.[1].find((l) => l.startsWith('USD'))).not.toMatch(/\(default\)/);
	});
});

describe('edit: the menu, "All of the above", Review and the write', () => {
	it('"All of the above" runs every section, the RPC list too', async () => {
		setup(BASE);
		registeredTag = 'my-custom-tag';
		// origin, 6 alt fields, 7 branding fields, listing fee (3: keep the
		// amounts, the fallback price, the unit), fees account, tag — all Enter.
		answers = [
			/^All of the above$/,
			'',
			...Array(6).fill(''),
			...Array(7).fill(''),
			'',
			'',
			'',
			'',
			''
		];
		expect(await edit()).toBe(0);
		expect(rpcCalls).toBe(1);
		expect(text()).toMatch(/Nothing changed\./);
	});

	it('the section list is printed once', async () => {
		setup(BASE);
		answers = [/^Cancel$/];
		await edit();
		const { askChoice } = await import('../src/init/prompt.ts');
		const call = vi.mocked(askChoice).mock.calls[0]!;
		expect(call[3]).toEqual({ showList: false });
		expect(printed.join('\n').match(/^\s*\d+\. Primary origin/gm)).toHaveLength(1);
		// The fees-account step refuses a blank or invalid name: the menu must
		// not promise a fallback for one.
		expect(text()).not.toMatch(/fall\s+back to the canonical @morphit-fees/);
		// The greeting names every section it can edit.
		expect(text()).toMatch(/fees account, operator tag and Blurt RPC endpoints/);
	});

	it('Review: plain names, one rule line, and the real file mode after the write', async () => {
		setup(BASE);
		chmodSync(cfg(), 0o640);
		answers = [/^Branding & SEO$/, '', '', 'A new tagline', '', '', '', '', 'y', 'n'];
		expect(await edit()).toBe(0);
		const out = text();
		expect(out).toMatch(/^ {2}Tagline$/m);
		expect(out).not.toMatch(/MORPHIT_INSTANCE_TAGLINE\s+A new tagline/);
		// One rule line of 58, not 58 lines of one.
		expect(out).not.toMatch(/^━$/m);
		expect(out).toMatch(/^━{58}\nReview$/m);
		expect(out).toMatch(/mode 0640/);
		expect(out).not.toMatch(/permissions 600/);
	});
});
