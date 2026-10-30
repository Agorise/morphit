/**
 * A setting `morphit-ops edit` writes is not undone by a file the service
 * reads after it (v1.21.10). Real files in a scratch root; what a service
 * "has" is what bash gets by sourcing its files in the unit's order — the
 * same `set -a; . file` the indexer and relay units run.
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	clearLaterShadows,
	confirmRunning,
	describeShadowFix,
	envValue,
	restartWithWritten,
	serviceEnvs,
	shadowPlan,
	withoutAssignments,
	type ServiceUnit,
	type ShadowFs
} from '../src/lib/laterEnvShadow.ts';

let root: string;
const CFG = () => join(root, 'opt/morphit/morphit.config.env');
const ENV = () => join(root, 'opt/morphit/morphit.env');
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

const OLD_IDX = [
	'MORPHIT_INDEXER_LISTEN_PORT=8081',
	'MORPHIT_INSTANCE_OPERATOR_TAG=morphit',
	'MORPHIT_INSTANCE_NAME=Morphit',
	'MORPHIT_INSTANCE_CONTACT_URL=https://matrix.to/#/#morphit:matrix.org',
	'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.old.example',
	''
].join('\n');

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'later-shadow-'));
	mkdirSync(join(root, 'opt/morphit'), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	writeFileSync(ENV(), "MORPHIT_INDEXER_RPC_ENDPOINTS='https://rpc.new.example'\n");
	// What `morphit-ops edit` just wrote.
	writeFileSync(
		CFG(),
		"MORPHIT_INSTANCE_NAME='Morphit NL'\nMORPHIT_INSTANCE_CONTACT_URL=mailto:operator@example.org\n"
	);
	writeFileSync(IDX(), OLD_IDX, { mode: 0o640 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a file read last undoes an edit (the case this is for)', () => {
	it('as an old install left it, the indexer keeps the Matrix contact', () => {
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_CONTACT_URL')).toBe(
			'https://matrix.to/#/#morphit:matrix.org'
		);
	});
});

describe('clearLaterShadows', () => {
	it('removes the written keys from indexer.env; the indexer then reads what was written; other lines stay', () => {
		const r = clearLaterShadows(['MORPHIT_INSTANCE_NAME', 'MORPHIT_INSTANCE_CONTACT_URL'], {
			envs: serviceEnvs(root)
		});
		expect(r.failed).toEqual([]);
		expect(r.removed).toHaveLength(1);
		expect(r.removed[0]).toMatchObject({
			unit: 'morphit-indexer',
			file: IDX(),
			keys: ['MORPHIT_INSTANCE_NAME', 'MORPHIT_INSTANCE_CONTACT_URL']
		});
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_CONTACT_URL')).toBe(
			'mailto:operator@example.org'
		);
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_NAME')).toBe('Morphit NL');
		expect(readFileSync(IDX(), 'utf8')).toBe(
			'MORPHIT_INDEXER_LISTEN_PORT=8081\nMORPHIT_INSTANCE_OPERATOR_TAG=morphit\nMORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.old.example\n'
		);
		// The file keeps its mode; the backup is the old file, private.
		expect(statSync(IDX()).mode & 0o777).toBe(0o640);
		expect(readFileSync(r.removed[0]!.backup, 'utf8')).toBe(OLD_IDX);
		expect(statSync(r.removed[0]!.backup).mode & 0o777).toBe(0o600);
		// Nothing left to do the second time.
		expect(
			clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) })
		).toEqual({
			removed: [],
			kept: [],
			failed: []
		});
	});

	it('only keys that were written: an unrelated key in indexer.env is left alone', () => {
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_NAME')).toBe('Morphit');
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_OPERATOR_TAG')).toBe('morphit');
	});

	it('an `export KEY=` line and a repeated line are removed too', () => {
		writeFileSync(
			IDX(),
			'export MORPHIT_INSTANCE_CONTACT_URL=https://old.example\nX=1\nMORPHIT_INSTANCE_CONTACT_URL="https://older.example"\n'
		);
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		expect(readFileSync(IDX(), 'utf8')).toBe('X=1\n');
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_CONTACT_URL')).toBe(
			'mailto:operator@example.org'
		);
	});

	it('a cleared setting (written as removed) is removed from indexer.env too', () => {
		writeFileSync(CFG(), "MORPHIT_INSTANCE_NAME='Morphit NL'\n");
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_CONTACT_URL')).toBeUndefined();
	});

	it('the Blurt node list: a stale list in indexer.env and relay.env is removed; the services read the new one', () => {
		writeFileSync(
			ENV(),
			"MORPHIT_INDEXER_RPC_ENDPOINTS='https://rpc.new.example'\nMORPHIT_RELAY_BLURT_RPC='https://rpc.new.example'\n"
		);
		writeFileSync(
			RLY(),
			'MORPHIT_RELAY_LISTEN_PORT=8080\nMORPHIT_RELAY_BLURT_RPC=https://rpc.old.example\n'
		);
		const r = clearLaterShadows(['MORPHIT_INDEXER_RPC_ENDPOINTS', 'MORPHIT_RELAY_BLURT_RPC'], {
			envs: serviceEnvs(root)
		});
		expect(r.removed.map((x) => x.unit)).toEqual(['morphit-indexer', 'morphit-relay']);
		expect(serviceSees('morphit-indexer', 'MORPHIT_INDEXER_RPC_ENDPOINTS')).toBe(
			'https://rpc.new.example'
		);
		expect(serviceSees('morphit-relay', 'MORPHIT_RELAY_BLURT_RPC')).toBe('https://rpc.new.example');
		expect(readFileSync(RLY(), 'utf8')).toBe('MORPHIT_RELAY_LISTEN_PORT=8080\n');
	});

	it('an EMPTY node list (a server set up not to use public nodes) is kept, and named', () => {
		writeFileSync(IDX(), 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
		writeFileSync(RLY(), "MORPHIT_RELAY_BLURT_RPC=''\n");
		const r = clearLaterShadows(['MORPHIT_INDEXER_RPC_ENDPOINTS', 'MORPHIT_RELAY_BLURT_RPC'], {
			envs: serviceEnvs(root)
		});
		expect(r.removed).toEqual([]);
		expect(r.kept.map((x) => x.key)).toEqual([
			'MORPHIT_INDEXER_RPC_ENDPOINTS',
			'MORPHIT_RELAY_BLURT_RPC'
		]);
		expect(serviceSees('morphit-indexer', 'MORPHIT_INDEXER_RPC_ENDPOINTS')).toBe('');
		expect(describeShadowFix(r).join('\n')).toMatch(/not to use public Blurt nodes/);
	});

	it('an empty display setting in indexer.env is not "kept": it would still blank the edit', () => {
		writeFileSync(IDX(), 'MORPHIT_INSTANCE_CONTACT_URL=\n');
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_CONTACT_URL')).toBe(
			'mailto:operator@example.org'
		);
	});

	it('no indexer.env or relay.env (a server set up by `morphit-ops init`): nothing to do', () => {
		rmSync(IDX());
		expect(
			clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) })
		).toEqual({
			removed: [],
			kept: [],
			failed: []
		});
	});

	it('no backup, no change: the file is left as it was and the failure is said plainly', () => {
		const fs: ShadowFs = {
			read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
			write: () => {
				throw new Error('must not write without a backup');
			},
			backup: () => null
		};
		const r = clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root), fs });
		expect(r.failed).toEqual([
			{ unit: 'morphit-indexer', file: IDX(), keys: ['MORPHIT_INSTANCE_CONTACT_URL'] }
		]);
		expect(readFileSync(IDX(), 'utf8')).toBe(OLD_IDX);
		expect(describeShadowFix(r)[0]).toMatch(
			/could not remove .* sudo systemctl restart morphit-indexer$/
		);
	});

	it('a write that did not stick (read back) is a failure, not a success', () => {
		const fs: ShadowFs = {
			read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
			write: () => true,
			backup: (p) => `${p}.bak`
		};
		expect(
			clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root), fs }).failed
		).toHaveLength(1);
	});

	it('no stray temporary files are left next to the file', () => {
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		expect(readdirSync(join(root, 'etc/morphit')).filter((f) => f.includes('tmp'))).toEqual([]);
	});
});

describe('the pure parts', () => {
	it('envValue: last wins, export, outer quotes', () => {
		expect(envValue(['A=1\nexport A="two words"\n', "A='3'\n"], 'A')).toBe('3');
		expect(envValue(['AB=1\n'], 'A')).toBeUndefined();
		expect(envValue(['# A=1\n'], 'A')).toBeUndefined();
	});
	it('withoutAssignments keeps comments and other keys', () => {
		expect(withoutAssignments('# A=1\nA=1\nAB=2\n', new Set(['A']))).toEqual({
			text: '# A=1\nAB=2\n',
			removed: ['A']
		});
	});
	it('shadowPlan: an unassigned key is neither dropped nor kept', () => {
		expect(shadowPlan(['A', 'B'], 'A=x\n')).toEqual({ drop: ['A'], keep: [] });
	});
});

describe('confirmRunning', () => {
	const env = (values: Record<string, string | undefined | null>) => ({
		processEnv: (_u: ServiceUnit, k: string) => (k in values ? values[k] : undefined),
		sleep: async () => {}
	});

	it('ok when the running indexer has what its files give it', async () => {
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		const r = await confirmRunning(['morphit-indexer'], ['MORPHIT_INSTANCE_CONTACT_URL'], {
			envs: serviceEnvs(root),
			runtime: env({ MORPHIT_INSTANCE_CONTACT_URL: 'mailto:operator@example.org' }),
			tries: 1
		});
		expect(r).toEqual({ ok: true, unreadable: false, down: [], wrong: [] });
	});

	it('names the key when the running indexer still has the old value', async () => {
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		const r = await confirmRunning(['morphit-indexer'], ['MORPHIT_INSTANCE_CONTACT_URL'], {
			envs: serviceEnvs(root),
			runtime: env({ MORPHIT_INSTANCE_CONTACT_URL: 'https://matrix.to/#/#morphit:matrix.org' }),
			tries: 2
		});
		expect(r.ok).toBe(false);
		expect(r.wrong).toEqual([
			{
				unit: 'morphit-indexer',
				key: 'MORPHIT_INSTANCE_CONTACT_URL',
				want: 'mailto:operator@example.org',
				got: 'https://matrix.to/#/#morphit:matrix.org'
			}
		]);
	});

	it('waits for the new process: right after the restart its shell has not read the files yet', async () => {
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		let calls = 0;
		const r = await confirmRunning(['morphit-indexer'], ['MORPHIT_INSTANCE_CONTACT_URL'], {
			envs: serviceEnvs(root),
			runtime: {
				processEnv: () => (++calls < 3 ? undefined : 'mailto:operator@example.org'),
				sleep: async () => {}
			}
		});
		expect(r.ok).toBe(true);
		expect(calls).toBe(3);
	});

	it('a removed setting: ok when the running indexer does not have it', async () => {
		writeFileSync(CFG(), '');
		clearLaterShadows(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: serviceEnvs(root) });
		const r = await confirmRunning(['morphit-indexer'], ['MORPHIT_INSTANCE_CONTACT_URL'], {
			envs: serviceEnvs(root),
			runtime: env({}),
			tries: 1
		});
		expect(r.ok).toBe(true);
	});

	it('an unreadable environment is not ok, and says so', async () => {
		const r = await confirmRunning(['morphit-indexer'], ['MORPHIT_INSTANCE_CONTACT_URL'], {
			envs: serviceEnvs(root),
			runtime: env({ MORPHIT_INSTANCE_CONTACT_URL: null }),
			tries: 1
		});
		expect(r).toMatchObject({ ok: false, unreadable: true });
	});
});

describe('restartWithWritten (what edit and alt-address run after saving)', () => {
	const run = async (
		written: string[],
		o: {
			restart?: boolean;
			envs?: ReturnType<typeof serviceEnvs>;
			running?: Record<string, string | undefined>;
		} = {}
	) => {
		const offered: string[][] = [];
		const lines: string[] = [];
		const restarted = await restartWithWritten(written, ['morphit-indexer'], {
			offer: async (u) => (offered.push([...u]), o.restart ?? true),
			print: (l) => lines.push(l),
			envs: o.envs ?? serviceEnvs(root),
			canRead: () => true,
			runtime: {
				processEnv: (_u, k) => (o.running ?? {})[k],
				sleep: async () => {}
			}
		});
		return { restarted, offered, text: lines.join('\n') };
	};

	it('clears the old copy, restarts, and confirms the running indexer has the new contact', async () => {
		const r = await run(['MORPHIT_INSTANCE_CONTACT_URL'], {
			running: { MORPHIT_INSTANCE_CONTACT_URL: 'mailto:operator@example.org' }
		});
		expect(r.restarted).toBe(true);
		expect(r.offered).toEqual([['morphit-indexer']]);
		expect(serviceSees('morphit-indexer', 'MORPHIT_INSTANCE_CONTACT_URL')).toBe(
			'mailto:operator@example.org'
		);
		expect(r.text).toMatch(/removed the old MORPHIT_INSTANCE_CONTACT_URL from .*indexer\.env/);
		expect(r.text).toMatch(/✓ checked: the running indexer use/);
	});

	it('says so, with how to see why, when the running indexer still has the old value', async () => {
		const r = await run(['MORPHIT_INSTANCE_CONTACT_URL'], {
			running: { MORPHIT_INSTANCE_CONTACT_URL: 'https://matrix.to/#/#morphit:matrix.org' }
		});
		expect(r.text).toMatch(
			/did not pick up the new MORPHIT_INSTANCE_CONTACT_URL after the restart: it runs with https:\/\/matrix\.to.*its settings give mailto:operator@example\.org.*sudo journalctl -u morphit-indexer -n 50 --no-pager$/m
		);
		// Just restarted: "restart it" again would be circular.
		expect(r.text).not.toMatch(/systemctl restart/);
		expect(r.text).not.toMatch(/✓ checked/);
	});

	it('the relay is restarted too when its own file was changed', async () => {
		writeFileSync(RLY(), 'MORPHIT_RELAY_BLURT_RPC=https://rpc.old.example\n');
		writeFileSync(ENV(), "MORPHIT_RELAY_BLURT_RPC='https://rpc.new.example'\n");
		const r = await run(['MORPHIT_RELAY_BLURT_RPC'], {
			running: { MORPHIT_RELAY_BLURT_RPC: 'https://rpc.new.example' }
		});
		expect(r.offered).toEqual([['morphit-indexer', 'morphit-relay']]);
	});

	it('not restarted: no check, no claim', async () => {
		const r = await run(['MORPHIT_INSTANCE_CONTACT_URL'], { restart: false });
		expect(r.restarted).toBe(false);
		expect(r.text).not.toMatch(/checked|still has/);
	});

	it('another copy of the settings (no service files): nothing cleared, nothing checked', async () => {
		const r = await run(['MORPHIT_INSTANCE_CONTACT_URL'], { envs: [] });
		expect(readFileSync(IDX(), 'utf8')).toBe(OLD_IDX);
		expect(r.text).toBe('');
	});
});
