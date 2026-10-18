/**
 * Every place that decides "is this server zero-clearnet?" from the indexer's
 * env file reads MORPHIT_INDEXER_RPC_ENDPOINTS the way the indexer's own
 * shell does (v1.21.10 review): the last line, `export` allowed, quotes
 * removed, and a `# comment` after a blank NOT part of the value. Before,
 * `MORPHIT_INDEXER_RPC_ENDPOINTS=   # tor-only` — empty for the indexer — read
 * as clearnet: morphit-ops offered and probed the clearnet nodes, first-online
 * POSTed to clearnet RPCs, and IPFS joined the public DHT. The truth here is
 * real bash sourcing the file, as the unit does.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isHiddenOnlyFromEnvFile } from '../src/init/hiddenUpgradeResolve.ts';

const REPO = join(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'hidden-only-readers-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CASES: ReadonlyArray<readonly [string, string]> = [
	['empty', 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n'],
	['a comment after blanks', 'MORPHIT_INDEXER_RPC_ENDPOINTS=   # tor-only: no clearnet\n'],
	['quoted empty, then a comment', 'MORPHIT_INDEXER_RPC_ENDPOINTS=""  # none (tor-only)\n'],
	['export, empty', 'export MORPHIT_INDEXER_RPC_ENDPOINTS=\n'],
	['commas only', 'MORPHIT_INDEXER_RPC_ENDPOINTS=,\n'],
	['CRLF line end', 'MORPHIT_INDEXER_RPC_ENDPOINTS=\r\nX=1\r\n'],
	[
		'empty, then a list (last wins)',
		'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n'
	],
	[
		'a list, then empty (last wins)',
		'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\nMORPHIT_INDEXER_RPC_ENDPOINTS=\n'
	],
	['a list', 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n'],
	['a list with a comment', 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org   # main\n'],
	[
		'a quoted list',
		'MORPHIT_INDEXER_RPC_ENDPOINTS="https://a.example.org,https://b.example.org"\n'
	],
	['a value that starts with #', 'MORPHIT_INDEXER_RPC_ENDPOINTS=#https://rpc.example.org\n']
];

let n = 0;
const file = (text: string): string => {
	const p = join(dir, `indexer-${n++}.env`);
	writeFileSync(p, text);
	return p;
};

/** What the indexer gets: real bash sourcing the file; hidden-only ⇔ no entry. */
function bashSaysHidden(p: string): boolean {
	const r = spawnSync(
		'bash',
		['-c', 'set -a; . "$1"; printf "%s" "${MORPHIT_INDEXER_RPC_ENDPOINTS-}"', '_', p],
		{ encoding: 'utf8', env: { PATH: process.env.PATH } }
	);
	expect(r.status).toBe(0);
	return r.stdout.split(',').every((e) => e.trim() === '');
}

/** The shell check copied out of a script (a function body or an `if` condition). */
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
function firstOnlineHidden(p: string): boolean {
	const s = src('ops/first-online/morphit-first-online.sh');
	const fn = (name: string): string => {
		const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(s);
		expect(m, name).not.toBeNull();
		return m![0];
	};
	const script = `INDEXER_ENV="$1"\n${fn('indexer_env_value')}\n${fn('hidden_only')}\nhidden_only && echo yes || echo no\n`;
	return spawnSync('sh', ['-c', script, '_', p], { encoding: 'utf8' }).stdout.trim() === 'yes';
}
function inlineHidden(rel: string, v: string, p: string): boolean {
	const m = /^if (\[ -[rf] "\$\w+" \] && grep[\s\S]*?); then$/m.exec(src(rel));
	expect(m, rel).not.toBeNull();
	const script = `${v}="$1"\nif ${m![1]}; then echo yes; else echo no; fi\n`;
	return spawnSync('bash', ['-c', script, '_', p], { encoding: 'utf8' }).stdout.trim() === 'yes';
}

describe('zero-clearnet is read from the indexer env file as the indexer reads it', () => {
	for (const [name, text] of CASES) {
		it(name, () => {
			const p = file(text);
			const truth = bashSaysHidden(p);
			expect(isHiddenOnlyFromEnvFile([p]), 'morphit-ops (isHiddenOnlyFromEnvFile)').toBe(truth);
			expect(firstOnlineHidden(p), 'first-online').toBe(truth);
			expect(
				inlineHidden('ops/pin-indexer-snapshot.sh', '_idxenv', p),
				'pin-indexer-snapshot'
			).toBe(truth);
			expect(inlineHidden('ops/ipfs/morphit-ipfs-setup.sh', 'IDX_ENV', p), 'ipfs-setup').toBe(
				truth
			);
		});
	}

	it('the key absent: not zero-clearnet (as before)', () => {
		const p = file('X=1\n');
		expect(isHiddenOnlyFromEnvFile([p])).toBe(false);
		expect(firstOnlineHidden(p)).toBe(false);
		expect(inlineHidden('ops/pin-indexer-snapshot.sh', '_idxenv', p)).toBe(false);
	});

	it('a value only running the file would tell ($VAR): taken as zero-clearnet, never as clearnet', () => {
		expect(isHiddenOnlyFromEnvFile([file('MORPHIT_INDEXER_RPC_ENDPOINTS=$NODES\n')])).toBe(true);
	});
});
