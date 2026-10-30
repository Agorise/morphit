/**
 * The frontend container's nginx.conf lives in the operator's Compose project
 * (<project>/frontend/nginx.conf), not in the release. Every upgrade copied the
 * release's over it with no backup and said "Refreshed the frontend nginx.conf
 * from the upgraded release." even when nothing changed (v1.21.17 audit, L10
 * and L1). Now: only when it differs, the previous copy kept first, and where
 * it is said. The real restartFrontendContainer runs with a stand-in docker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stub } from './helpers/pty.ts';

const savedPath = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
	process.env.PATH = savedPath;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function rebuild(
	projectConf: string,
	releaseConf: string,
	o: {
		restoring?: boolean;
		olderCopies?: string[];
		failCopy?: 'backup' | 'write';
		/** Through rollback(): the release put back is in `install`. */
		viaRollback?: boolean;
	} = {}
) {
	const d = mkdtempSync(join(tmpdir(), 'fe-conf-'));
	dirs.push(d);
	const proj = join(d, 'bunkerweb');
	mkdirSync(join(proj, 'frontend'), { recursive: true });
	writeFileSync(join(proj, 'docker-compose.yml'), 'services: {}\n');
	writeFileSync(join(proj, 'frontend', 'nginx.conf'), projectConf);
	for (const n of o.olderCopies ?? []) writeFileSync(join(proj, 'frontend', n), `# ${n}\n`);
	const install = join(d, 'opt');
	mkdirSync(join(install, 'ops', 'bunkerweb', 'frontend'), { recursive: true });
	writeFileSync(join(install, 'ops', 'bunkerweb', 'frontend', 'nginx.conf'), releaseConf);
	const inspect = JSON.stringify([
		{
			Name: '/bunkerweb-frontend-1',
			Config: {
				Image: 'bunkerweb-frontend',
				Labels: {
					'com.docker.compose.project': 'bunkerweb',
					'com.docker.compose.service': 'frontend',
					'com.docker.compose.project.config_files': join(proj, 'docker-compose.yml'),
					'com.docker.compose.project.working_dir': proj
				}
			},
			State: { Running: true }
		}
	]);
	const bin = join(d, 'bin');
	mkdirSync(bin);
	stub(bin, 'docker', `case "$1" in inspect) cat <<'J'\n${inspect}\nJ\n;; esac\nexit 0`);
	process.env.PATH = `${bin}:${savedPath}`;
	vi.resetModules();
	if (o.failCopy !== undefined) {
		const fail = o.failCopy;
		vi.doMock('node:fs', async (orig) => {
			const fs = (await orig()) as typeof import('node:fs');
			return {
				...fs,
				copyFileSync: (a: string, b: string, mode?: number) => {
					const isBackup = String(b).includes('.bak-');
					if (
						(fail === 'backup' && isBackup) ||
						(fail === 'write' && String(b).endsWith('nginx.conf'))
					)
						throw new Error('ENOSPC: no space left on device');
					return fs.copyFileSync(a, b, mode);
				}
			};
		});
	}
	const { restartFrontendContainer } = await import('../src/commands/upgrade.ts');
	vi.doUnmock('node:fs');
	let out = '';
	const grab = (c: unknown): boolean => ((out += String(c)), true);
	vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
	vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
	if (o.viaRollback) {
		const { rollback } = await import('../src/commands/upgrade.ts');
		const failed = join(d, 'opt-new');
		mkdirSync(failed);
		const saved = process.env.MORPHIT_STEP_LOG_DIR;
		process.env.MORPHIT_STEP_LOG_DIR = join(d, 'logs');
		try {
			await rollback(
				failed,
				install,
				join(d, 'tmp'),
				new Error('a test failure'),
				{ webRoot: join(d, 'www'), webRootBackup: null, container: 'bunkerweb-frontend-1' },
				[],
				{ systemctl: () => ({ status: 3 }) }
			);
		} finally {
			if (saved === undefined) delete process.env.MORPHIT_STEP_LOG_DIR;
			else process.env.MORPHIT_STEP_LOG_DIR = saved;
		}
	} else
		await restartFrontendContainer('bunkerweb-frontend-1', install, {
			...(o.restoring ? { restoring: true } : {})
		});
	vi.restoreAllMocks();
	return { out, front: join(proj, 'frontend') };
}

describe("the frontend container's nginx.conf on upgrade", () => {
	it('a changed one: the previous copy is kept, and where is said', async () => {
		const r = await rebuild("# the operator's own edit\n", '# this release\n');
		expect(readFileSync(join(r.front, 'nginx.conf'), 'utf8')).toBe('# this release\n');
		const kept = readdirSync(r.front).filter((n) => n.startsWith('nginx.conf.bak-'));
		expect(kept).toHaveLength(1);
		expect(readFileSync(join(r.front, kept[0]!), 'utf8')).toBe("# the operator's own edit\n");
		expect(r.out).toContain(`the previous one is kept at ${join(r.front, kept[0]!)}`);
	});
	// v1.21.18 audit, L5: one copy per upgrade piled up.
	it('only the two newest copies are kept (the operator’s own files are left alone)', async () => {
		const r = await rebuild("# the operator's own edit\n", '# this release\n', {
			olderCopies: [
				'nginx.conf.bak-2026-01-01T00-00-00-000Z',
				'nginx.conf.bak-2026-02-01T00-00-00-000Z',
				'nginx.conf.bak-2026-03-01T00-00-00-000Z',
				'nginx.conf.bak-mine'
			]
		});
		const left = readdirSync(r.front)
			.filter((n) => n.startsWith('nginx.conf.bak-'))
			.sort();
		expect(left).toHaveLength(3);
		expect(left).toContain('nginx.conf.bak-mine');
		expect(left).toContain('nginx.conf.bak-2026-03-01T00-00-00-000Z');
		expect(left).not.toContain('nginx.conf.bak-2026-01-01T00-00-00-000Z');
		expect(left).not.toContain('nginx.conf.bak-2026-02-01T00-00-00-000Z');
		// and the copy of the file it replaced is one of the two
		const newest = left.filter((n) => /\d{3}Z$/.test(n) && !n.startsWith('nginx.conf.bak-2026-03'));
		expect(newest).toHaveLength(1);
		expect(readFileSync(join(r.front, newest[0]!), 'utf8')).toBe("# the operator's own edit\n");
	});
	it('a rollback puts back the previous release’s settings, and says so (not "this release’s")', async () => {
		const r = await rebuild('# the failed release\n', '# the restored release\n', {
			viaRollback: true
		});
		expect(readFileSync(join(r.front, 'nginx.conf'), 'utf8')).toBe('# the restored release\n');
		expect(r.out).toMatch(/now has the restored release's settings/);
		expect(r.out).not.toMatch(/this release's settings/);
	});
	it('the copy of the current file cannot be made: said, with the exact commands; the file is left as it was', async () => {
		const r = await rebuild("# the operator's own edit\n", '# this release\n', {
			failCopy: 'backup'
		});
		expect(readFileSync(join(r.front, 'nginx.conf'), 'utf8')).toBe("# the operator's own edit\n");
		expect(r.out).toMatch(
			/nginx\.conf \(\S+\) was left as it was: a copy of it could not be kept first \(ENOSPC: no space left on device\), so this release's settings were not put in it\. On this server: sudo cp \S+nginx\.conf \S+nginx\.conf\.bak && sudo cp \S+ \S+nginx\.conf && sudo docker compose -p bunkerweb .* up -d --no-deps --build --force-recreate frontend/
		);
	});
	it('the new file cannot be written: said, with where the previous one is kept', async () => {
		const r = await rebuild("# the operator's own edit\n", '# this release\n', {
			failCopy: 'write'
		});
		expect(r.out).toMatch(
			/nginx\.conf \(\S+\) could not be written \(ENOSPC: no space left on device\), so this release's settings were not put in it \(the previous one is kept at \S+nginx\.conf\.bak-\S+\)\. On this server: sudo cp /
		);
	});
	it('the same as the release: not touched, nothing said', async () => {
		const r = await rebuild('# this release\n', '# this release\n');
		expect(readdirSync(r.front).filter((n) => n.startsWith('nginx.conf.bak-'))).toEqual([]);
		expect(r.out).not.toMatch(/nginx\.conf/);
		expect(existsSync(join(r.front, 'nginx.conf'))).toBe(true);
	});
});
