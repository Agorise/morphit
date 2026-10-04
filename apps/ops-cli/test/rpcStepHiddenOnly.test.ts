/**
 * `morphit-ops edit` → RPC endpoints on a hidden-only node: the step used to probe every endpoint it was given, and
 * offered the six clearnet defaults, straight from the box. On a hidden-only
 * node it now opens no connection at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const answers: string[] = [];
let yes = false;
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	ask: async (_q: string, def?: string) => {
		if (answers.length === 0) throw new Error(`asked again (default offered: ${def ?? ''})`);
		return answers.shift()!;
	},
	askYesNo: async () => yes,
	step: () => {},
	explain: () => {}
}));

const { stepRpcEndpoints } = await import('../src/init/steps.ts');

const root = mkdtempSync(join(tmpdir(), 'rpc-hidden-'));
const fetches: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	writeFileSync(join(root, 'etc', 'morphit', 'indexer.env'), 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
	process.env.MORPHIT_ENV_ROOT = root;
	globalThis.fetch = (async (u: unknown) => {
		fetches.push(String(u));
		throw new Error('no network in this test');
	}) as typeof fetch;
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
	globalThis.fetch = realFetch;
	delete process.env.MORPHIT_ENV_ROOT;
	rmSync(root, { recursive: true, force: true });
});

describe('RPC endpoints step on a hidden-only node', () => {
	it('Enter keeps the empty list and nothing is fetched', async () => {
		answers.splice(0, answers.length, '');
		const r = await stepRpcEndpoints([]);
		expect(r).toEqual([]);
		expect(fetches, 'the box contacted RPC nodes').toEqual([]);
	});

	it('a typed clearnet list is not probed, and is kept only on an explicit yes', async () => {
		answers.splice(0, answers.length, 'https://rpc.blurt.blog,https://rpc.beblurt.com');
		yes = false;
		expect(await stepRpcEndpoints([])).toEqual([]);
		answers.splice(0, answers.length, 'https://rpc.blurt.blog');
		yes = true;
		expect(await stepRpcEndpoints([])).toEqual(['https://rpc.blurt.blog']);
		expect(fetches, 'the box contacted RPC nodes').toEqual([]);
	});
});
