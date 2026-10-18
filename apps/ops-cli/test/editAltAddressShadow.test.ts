/**
 * `morphit-ops edit` and `morphit-ops alt-address`
 * end to end against scratch files under MORPHIT_ENV_ROOT — what they clear
 * in the files a service reads last, and which services they restart.
 * Prompts, the restart and the register broadcast are stubbed; the RPC step's
 * reachability probe is stubbed (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let choices: Array<number | RegExp> = [];
let asks: string[] = [];
let rpcList: string[] = [];
const offered: string[][] = [];

vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		askChoice: vi.fn(async (_q: string, opts: readonly string[]) => {
			const c = choices.shift();
			if (c === undefined) throw new Error('more menus than the test answers');
			if (typeof c === 'number') return c;
			const i = opts.findIndex((o) => c.test(o));
			if (i < 0) throw new Error(`no ${String(c)} in [${opts.join(' | ')}]`);
			return i;
		}),
		ask: vi.fn(async (_q: string, d?: string) => {
			const a = asks.shift() ?? '';
			return a === '' ? (d ?? '') : a;
		}),
		askYesNo: vi.fn(async (q: string) => /apply these changes|save it\?|really delete/i.test(q))
	};
});
vi.mock('../src/lib/restartServices.ts', () => ({
	offerRestart: vi.fn(async (units: readonly string[]) => (offered.push([...units]), false))
}));
vi.mock('../src/commands/register.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, runRegister: vi.fn(async () => 0) };
});
vi.mock('../src/init/steps.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, stepRpcEndpoints: vi.fn(async () => rpcList) };
});

const { runEdit } = await import('../src/commands/edit.ts');
const { runAltAddress } = await import('../src/commands/altAddress.ts');

const ONION_OLD = `${'b'.repeat(56)}.onion`;
const ONION_NEW = `${'a'.repeat(56)}.onion`;
let root = '';
const saved = { ...process.env };
const live = () => join(root, 'opt/morphit');
const cfg = () => join(live(), 'morphit.config.env');
const env = () => join(live(), 'morphit.env');
const idx = () => join(root, 'etc/morphit/indexer.env');

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'edit-shadow-'));
	mkdirSync(live(), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	writeFileSync(cfg(), `MORPHIT_INSTANCE_NAME=Site\nMORPHIT_INSTANCE_TOR_ADDRESS=${ONION_OLD}\n`);
	choices = [];
	asks = [];
	rpcList = [];
	offered.length = 0;
	process.env.MORPHIT_ENV_ROOT = root;
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

// alt-address → Tor → set it up: prefix, the address, "serve it too?" no, save.
const TOR_SAVE = () => {
	choices = [0, 0, 6];
	asks = ['', ONION_NEW];
};

describe('alt-address and the copy in indexer.env', () => {
	it('saving on the live settings removes the stale copy the indexer reads last', async () => {
		writeFileSync(idx(), `X=1\nMORPHIT_INSTANCE_TOR_ADDRESS=${ONION_OLD}\n`);
		TOR_SAVE();
		expect(await runAltAddress({ flags: { out: live() }, positional: [] } as never)).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toMatch(`MORPHIT_INSTANCE_TOR_ADDRESS=${ONION_NEW}`);
		expect(readFileSync(idx(), 'utf8')).toBe('X=1\n');
	});

	it('deleting on the live settings removes the stale copy too', async () => {
		writeFileSync(idx(), `X=1\nMORPHIT_INSTANCE_TOR_ADDRESS=${ONION_OLD}\n`);
		choices = [0, 1, 6]; // Tor → Delete it → Done
		expect(await runAltAddress({ flags: { out: live() }, positional: [] } as never)).toBe(0);
		expect(readFileSync(idx(), 'utf8')).toBe('X=1\n');
	});

	it('--out elsewhere (another copy of the settings): the server’s indexer.env is left alone', async () => {
		const IDX_TEXT = `X=1\nMORPHIT_INSTANCE_TOR_ADDRESS=${ONION_OLD}\n`;
		writeFileSync(idx(), IDX_TEXT);
		const other = join(root, 'elsewhere');
		mkdirSync(other);
		writeFileSync(join(other, 'morphit.config.env'), 'MORPHIT_INSTANCE_NAME=Other\n');
		TOR_SAVE();
		expect(await runAltAddress({ flags: { out: other }, positional: [] } as never)).toBe(0);
		expect(readFileSync(join(other, 'morphit.config.env'), 'utf8')).toMatch(ONION_NEW);
		expect(readFileSync(idx(), 'utf8')).toBe(IDX_TEXT);
	});
});

describe('which services are restarted', () => {
	it('edit → Blurt RPC endpoints on a `morphit-ops init` server: the relay too (it reads the same list)', async () => {
		writeFileSync(
			env(),
			"MORPHIT_INDEXER_RPC_ENDPOINTS='https://old.example'\nMORPHIT_RELAY_BLURT_RPC='https://old.example'\n"
		);
		choices = [/blurt rpc/i];
		rpcList = ['https://rpc.example.org'];
		expect(await runEdit({ flags: { out: live() }, positional: [] } as never)).toBe(0);
		expect(readFileSync(env(), 'utf8')).toMatch(
			/MORPHIT_RELAY_BLURT_RPC=https:\/\/rpc\.example\.org/
		);
		expect(offered).toEqual([['morphit-indexer', 'morphit-relay']]);
	});

	it('edit → a new site name: the relay is restarted too — its notes name the site', async () => {
		choices = [/branding & seo/i];
		asks = ['New Name'];
		expect(await runEdit({ flags: { out: live() }, positional: [] } as never)).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toMatch(/^MORPHIT_INSTANCE_NAME='?New Name'?$/m);
		expect(offered[0]).toContain('morphit-relay');
	});

	it('alt-address → a new .onion: the relay is restarted too — its notes link to it', async () => {
		TOR_SAVE();
		expect(await runAltAddress({ flags: { out: live() }, positional: [] } as never)).toBe(0);
		expect(offered[0]).toContain('morphit-relay');
	});
});
