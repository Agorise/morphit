/**
 * The Blurt RPC endpoints step (`edit` → Blurt RPC endpoints; also the
 * install wizard), on a node that is not hidden-only:
 *
 *  - Enter (keep the list shown) used to probe every node anyway; with none
 *    answering it asked "Use this list anyway? [y/N]", Enter said No, and the
 *    question came round again, for ever. Enter now keeps the list as it is,
 *    with nothing checked.
 *  - A typed list that no node answers is still asked about (default No) —
 *    and Enter at the next question then keeps the current list: no dead end.
 *  - From `edit`, which offers the indexer restart itself, the step no longer
 *    tells the operator to restart it by hand; `edit` really passes that.
 *
 * Prompts answer from a script ('' = Enter); every fetch is refused and
 * recorded (no node answers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Answer = string | RegExp;
let answers: Answer[] = [];
const asked: Array<{ kind: string; q: string }> = [];
let explained: string[] = [];
const next = (kind: string, q: string): Answer => {
	asked.push({ kind, q });
	if (answers.length === 0) throw new Error(`no answer scripted for ${kind}: ${q}`);
	return answers.shift()!;
};

vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		ask: vi.fn(async (q: string, d?: string) => {
			const a = next('ask', q);
			return a === '' ? (d ?? '') : String(a);
		}),
		askYesNo: vi.fn(async (q: string, d: boolean) => {
			const a = next('yesno', q);
			return a === '' ? d : /^y/i.test(String(a));
		}),
		askChoice: vi.fn(async (q: string, choices: readonly string[], d?: number) => {
			const a = next('choice', q);
			if (a === '') return d ?? 0;
			if (a instanceof RegExp) {
				const i = choices.findIndex((c) => a.test(c));
				if (i < 0) throw new Error(`no ${String(a)} in [${choices.join(' | ')}]`);
				return i;
			}
			return Number(a);
		}),
		explain: vi.fn((t: string) => void explained.push(t))
	};
});
const offered: string[][] = [];
vi.mock('../src/lib/restartServices.ts', () => ({
	offerRestart: vi.fn(async (units: readonly string[]) => (offered.push([...units]), false))
}));

const { stepRpcEndpoints } = await import('../src/init/steps.ts');
const { runEdit } = await import('../src/commands/edit.ts');

const CURRENT = ['https://rpc-a.example.org', 'https://rpc-b.example.org'];
let fetched: string[] = [];
let printed: string[] = [];
let root = '';
const saved = { ...process.env };

beforeEach(() => {
	answers = [];
	asked.length = 0;
	explained = [];
	offered.length = 0;
	fetched = [];
	printed = [];
	root = mkdtempSync(join(tmpdir(), 'rpc-step-'));
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	mkdirSync(join(root, 'opt/morphit'), { recursive: true });
	// Not hidden-only: a clearnet list in indexer.env.
	writeFileSync(
		join(root, 'etc/morphit/indexer.env'),
		`MORPHIT_INDEXER_RPC_ENDPOINTS=${CURRENT.join(',')}\n`
	);
	process.env.MORPHIT_ENV_ROOT = root;
	vi.stubGlobal('fetch', async (u: unknown) => {
		fetched.push(String(u instanceof Request ? u.url : u));
		throw new Error('fetch failed (no node answers in this test)');
	});
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

describe('RPC endpoints step: Enter keeps the list', () => {
	it('Enter returns the current list at once: no node is asked, no "use anyway?" question', async () => {
		answers = [''];
		expect(await stepRpcEndpoints(CURRENT, { hiddenOnly: false })).toEqual(CURRENT);
		expect(fetched).toEqual([]);
		expect(asked.filter((a) => a.kind === 'yesno')).toEqual([]);
	});

	it('a typed list no node answers: asked (default No); Enter at the next question keeps the current list', async () => {
		answers = ['https://rpc-c.example.org', '', ''];
		expect(await stepRpcEndpoints(CURRENT, { hiddenOnly: false })).toEqual(CURRENT);
		expect(fetched.some((u) => u.startsWith('https://rpc-c.example.org'))).toBe(true);
		expect(asked.map((a) => a.kind)).toEqual(['ask', 'yesno', 'ask']);
		expect(asked[1]!.q).toMatch(/Use this list anyway/);
	});
});

describe('RPC endpoints step: the restart advice', () => {
	it('from the install wizard: says to restart the indexer, on this server, with sudo', async () => {
		answers = [''];
		await stepRpcEndpoints(null, { hiddenOnly: false });
		expect(explained.join('\n')).toMatch(
			/on this server:\s+sudo systemctl restart morphit-indexer/
		);
	});

	it('from `edit` (it offers the restart itself): no "you must restart" advice', async () => {
		writeFileSync(join(root, 'opt/morphit/morphit.config.env'), 'MORPHIT_INSTANCE_NAME=Example\n');
		writeFileSync(
			join(root, 'opt/morphit/morphit.env'),
			`MORPHIT_RELAY_ACCOUNT=example-relay\nMORPHIT_INDEXER_RPC_ENDPOINTS='${CURRENT.join(',')}'\n`
		);
		const before = readFileSync(join(root, 'opt/morphit/morphit.env'), 'utf8');
		answers = [/^Blurt RPC endpoints$/, ''];
		expect(
			await runEdit({ flags: { out: join(root, 'opt/morphit') }, positional: [] } as never)
		).toBe(0);
		const all = [...explained, ...printed].join('\n');
		expect(explained.join('\n')).toMatch(/Blurt RPC endpoints your indexer connects to/);
		expect(all).not.toMatch(/must restart the indexer/);
		expect(fetched).toEqual([]);
		expect(readFileSync(join(root, 'opt/morphit/morphit.env'), 'utf8')).toBe(before);
	});
});
