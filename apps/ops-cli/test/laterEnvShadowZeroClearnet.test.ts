/**
 * A file read later must never be "healed" into using
 * clearnet Blurt nodes on a server set up to use none, and the tool must not
 * claim the running services use a setting they ignore. Real files in a
 * scratch root; what a service "has" is what bash gets by sourcing its files
 * in the unit's order — the same `set -a; . file` the units run.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isHiddenOnlyEndpointSet } from '@morphit/hidden-transport';
import {
	clearLaterShadows,
	confirmRunning,
	restartWithWritten,
	serviceEnvs,
	type ServiceUnit
} from '../src/lib/laterEnvShadow.ts';

let root: string;
const ENV = () => join(root, 'opt/morphit/morphit.env');
const CFG = () => join(root, 'opt/morphit/morphit.config.env');
const IDX = () => join(root, 'etc/morphit/indexer.env');
const RLY = () => join(root, 'etc/morphit/relay.env');

/** What the unit's shell gives the service for `key` (undefined: not set). */
function serviceSees(unit: ServiceUnit, key: string): string | undefined {
	const files = serviceEnvs(root).find((s) => s.unit === unit)!.files;
	const r = spawnSync(
		'bash',
		[
			'-c',
			'set -a; for f in "$@"; do [ -e "$f" ] && . "$f"; done; set +a; if [ -n "${' +
				key +
				'+x}" ]; then printf "set:%s" "$' +
				key +
				'"; fi',
			'_',
			...files
		],
		{ encoding: 'utf8', env: { PATH: process.env.PATH } }
	);
	expect(r.status).toBe(0);
	return r.stdout.startsWith('set:') ? r.stdout.slice(4) : undefined;
}

const CLEARNET = 'https://rpc.example.org,https://rpc2.example.org';

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'later-shadow-'));
	mkdirSync(join(root, 'opt/morphit'), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	// What `morphit-ops edit` → Blurt RPC endpoints just wrote.
	writeFileSync(
		ENV(),
		`MORPHIT_INDEXER_RPC_ENDPOINTS='${CLEARNET}'\nMORPHIT_RELAY_BLURT_RPC='${CLEARNET}'\n`
	);
	writeFileSync(CFG(), 'MORPHIT_INSTANCE_NAME=Site\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a zero-clearnet server stays zero-clearnet', () => {
	// Each line is EMPTY to bash (the service uses no clearnet node), written in a
	// shape an operator may leave when following the docs by hand.
	const EMPTY_SHAPES: Array<[string, string]> = [
		[
			'a comment after the empty value',
			'MORPHIT_INDEXER_RPC_ENDPOINTS=   # tor-only: no clearnet\n'
		],
		['quoted empty, then a comment', 'MORPHIT_INDEXER_RPC_ENDPOINTS=""  # none (tor-only)\n'],
		['a comment with no blank after the #', 'MORPHIT_INDEXER_RPC_ENDPOINTS=  #tor-only\n']
	];
	for (const [name, line] of EMPTY_SHAPES) {
		it(`indexer.env: ${name} — kept, so the indexer still uses no clearnet node`, () => {
			writeFileSync(IDX(), `MORPHIT_INDEXER_LISTEN_PORT=8081\n${line}`);
			// Before: bash gives the indexer no clearnet node at all.
			expect((serviceSees('morphit-indexer', 'MORPHIT_INDEXER_RPC_ENDPOINTS') ?? '').trim()).toBe(
				''
			);
			clearLaterShadows(['MORPHIT_INDEXER_RPC_ENDPOINTS'], { envs: serviceEnvs(root) });
			// After: still none — never the clearnet list from morphit.env.
			expect((serviceSees('morphit-indexer', 'MORPHIT_INDEXER_RPC_ENDPOINTS') ?? '').trim()).toBe(
				''
			);
		});
	}

	it('relay.env: a node list of hidden (.onion) nodes only — the relay stays hidden-only', () => {
		const onion = `http://${'a'.repeat(56)}.onion:8091`;
		writeFileSync(RLY(), `MORPHIT_RELAY_BLURT_RPC=${onion}\nMORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS=\n`);
		const hiddenOnly = (): boolean =>
			isHiddenOnlyEndpointSet(
				(serviceSees('morphit-relay', 'MORPHIT_RELAY_BLURT_RPC') ?? '')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean),
				[]
			);
		// The relay's own rule (apps/relay/src/config/index.ts relayIsHiddenOnly).
		expect(hiddenOnly()).toBe(true);
		clearLaterShadows(['MORPHIT_RELAY_BLURT_RPC'], { envs: serviceEnvs(root) });
		expect(hiddenOnly()).toBe(true);
	});
});

describe('the check after the restart says only what is true', () => {
	it('a kept empty node list: no "the running indexer uses the new settings"', async () => {
		writeFileSync(IDX(), 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
		const lines: string[] = [];
		await restartWithWritten(['MORPHIT_INDEXER_RPC_ENDPOINTS'], ['morphit-indexer'], {
			offer: async () => true,
			print: (l) => lines.push(l),
			envs: serviceEnvs(root),
			canRead: () => true,
			// The running indexer has what its files give it: no clearnet node.
			runtime: { processEnv: () => '', sleep: async () => {} }
		});
		const text = lines.join('\n');
		expect(text).toMatch(/not to use public Blurt nodes/);
		// The list just typed is NOT what the running indexer uses.
		expect(text).not.toMatch(/✓ checked: the running indexer uses? the new settings/);
	});

	it('the confirmation compares what bash gives, not the raw text (a comment after a value)', async () => {
		writeFileSync(CFG(), 'MORPHIT_INSTANCE_NAME=Site   # the site name\n');
		const r = await confirmRunning(['morphit-indexer'], ['MORPHIT_INSTANCE_NAME'], {
			envs: serviceEnvs(root),
			runtime: {
				processEnv: (u, k) => serviceSees(u, k),
				sleep: async () => {}
			},
			tries: 1
		});
		expect(r).toEqual({ ok: true, unreadable: false, wrong: [] });
	});
});

describe('guard for a check no test held', () => {
	it('not root (the running services cannot be read): nothing is asked of them, nothing claimed', async () => {
		writeFileSync(IDX(), 'MORPHIT_INSTANCE_NAME=Old\n');
		let asked = 0;
		const lines: string[] = [];
		const restarted = await restartWithWritten(['MORPHIT_INSTANCE_NAME'], ['morphit-indexer'], {
			offer: async () => true,
			print: (l) => lines.push(l),
			envs: serviceEnvs(root),
			canRead: () => false,
			runtime: {
				processEnv: () => {
					asked++;
					return null;
				},
				sleep: async () => {}
			}
		});
		expect(restarted).toBe(true);
		expect(asked).toBe(0);
		expect(lines.join('\n')).not.toMatch(/checked|still has/);
	});
});
