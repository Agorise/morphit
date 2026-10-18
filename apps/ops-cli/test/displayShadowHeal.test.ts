/**
 * The upgrade heal for install-time copies of the site's own name, tagline,
 * contact link and addresses in /etc/morphit/indexer.env (read after
 * morphit.config.env, last wins). Real files in a scratch root; what the
 * indexer "has" after a restart is what bash gets sourcing its files in the
 * unit's order.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { healDisplayShadow, type DisplayShadowRuntime } from '../src/lib/displayShadowHeal.ts';
import { serviceEnvs } from '../src/lib/laterEnvShadow.ts';

let root: string;
const CFG = () => join(root, 'opt/morphit/morphit.config.env');
const IDX = () => join(root, 'etc/morphit/indexer.env');
const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };

/** The indexer as a process: its environment is what its files gave it at its last start. */
class Indexer {
	env = new Map<string, string>();
	restarts = 0;
	active = true;
	constructor() {
		this.start();
	}
	start(): void {
		const files = serviceEnvs(root).find((s) => s.unit === 'morphit-indexer')!.files;
		const r = spawnSync(
			'bash',
			['-c', 'set -a; for f in "$@"; do [ -e "$f" ] && . "$f"; done; env -0', '_', ...files],
			{ encoding: 'utf8', env: { PATH: process.env.PATH } }
		);
		this.env = new Map(
			r.stdout
				.split('\0')
				.filter((e) => e.startsWith('MORPHIT_'))
				.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)] as const)
		);
	}
	readonly rt: DisplayShadowRuntime = {
		indexerActive: () => this.active,
		restartIndexer: () => (this.restarts++, this.start(), true),
		running: { processEnv: (_u, k) => this.env.get(k), sleep: async () => {} }
	};
	heal() {
		return healDisplayShadow(ctx, { runtime: this.rt, root });
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'display-shadow-'));
	mkdirSync(join(root, 'opt/morphit'), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	writeFileSync(
		CFG(),
		"MORPHIT_INSTANCE_NAME='Morphit NL'\nMORPHIT_INSTANCE_CONTACT_URL=mailto:operator@example.org\n"
	);
	writeFileSync(
		IDX(),
		'MORPHIT_INDEXER_LISTEN_PORT=8081\nMORPHIT_INSTANCE_NAME=Morphit\nMORPHIT_INSTANCE_CONTACT_URL=https://matrix.to/#/#morphit:matrix.org\nMORPHIT_INSTANCE_TAGLINE="only here"\n'
	);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('install-time display settings in indexer.env', () => {
	it('as an old install left it, the indexer shows the Matrix contact — the case the heal is for', () => {
		expect(new Indexer().env.get('MORPHIT_INSTANCE_CONTACT_URL')).toBe(
			'https://matrix.to/#/#morphit:matrix.org'
		);
	});

	it('removes the copies morphit.config.env also sets, restarts, and the indexer uses morphit.config.env', async () => {
		const ix = new Indexer();
		const out = await ix.heal();
		expect(out).toMatchObject({ strategy: 'removed-restarted', verified: true });
		expect(ix.restarts).toBe(1);
		expect(ix.env.get('MORPHIT_INSTANCE_CONTACT_URL')).toBe('mailto:operator@example.org');
		expect(ix.env.get('MORPHIT_INSTANCE_NAME')).toBe('Morphit NL');
		// A setting only indexer.env has stays (removing it would lose it).
		expect(ix.env.get('MORPHIT_INSTANCE_TAGLINE')).toBe('only here');
		expect(readFileSync(IDX(), 'utf8')).toBe(
			'MORPHIT_INDEXER_LISTEN_PORT=8081\nMORPHIT_INSTANCE_TAGLINE="only here"\n'
		);
		const again = await ix.heal();
		expect(again).toMatchObject({ strategy: 'already', routine: true });
		expect(ix.restarts).toBe(1);
	});

	it('the same value in both files: removed, no restart (nothing the indexer uses changes)', async () => {
		writeFileSync(CFG(), 'MORPHIT_INSTANCE_NAME=Morphit\n');
		writeFileSync(IDX(), 'MORPHIT_INSTANCE_NAME="Morphit"\n');
		const ix = new Indexer();
		expect(await ix.heal()).toMatchObject({ strategy: 'removed', verified: true });
		expect(ix.restarts).toBe(0);
	});

	it('the indexer not running: removed, no restart; it takes effect at its start', async () => {
		const ix = new Indexer();
		ix.active = false;
		const out = await ix.heal();
		expect(out.strategy).toBe('removed');
		expect(out.detail).toMatch(/takes effect when the indexer starts/);
		expect(ix.restarts).toBe(0);
	});

	it('a restart that did not bring the new values is not called verified, and says what to run', async () => {
		const ix = new Indexer();
		ix.rt.restartIndexer = () => true; // the process kept its old environment
		const out = await healDisplayShadow(ctx, {
			runtime: {
				...ix.rt,
				restartIndexer: () => true,
				running: { processEnv: (_u, k) => ix.env.get(k), sleep: async () => {} }
			},
			root
		});
		expect(out).toMatchObject({ strategy: 'removed-restarted', verified: false });
		expect(out.detail).toMatch(/sudo systemctl restart morphit-indexer/);
	});

	it('only display settings: the operator tag and node lists in indexer.env are not touched', async () => {
		writeFileSync(
			CFG(),
			'MORPHIT_INSTANCE_OPERATOR_TAG=new\nMORPHIT_INDEXER_RPC_ENDPOINTS=https://a.example\n'
		);
		writeFileSync(
			IDX(),
			'MORPHIT_INSTANCE_OPERATOR_TAG=old\nMORPHIT_INDEXER_RPC_ENDPOINTS=https://b.example\n'
		);
		expect((await new Indexer().heal()).strategy).toBe('already');
		expect(readFileSync(IDX(), 'utf8')).toContain('OPERATOR_TAG=old');
	});

	it('no indexer.env (a server set up by `morphit-ops init`): skipped, quietly', async () => {
		rmSync(IDX());
		expect(await new Indexer().heal()).toMatchObject({ strategy: 'skipped', routine: true });
	});
});
