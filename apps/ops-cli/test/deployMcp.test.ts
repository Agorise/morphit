/**
 * ops/scripts/deploy-mcp.sh lays the MCP server's runtime tree down from the
 * install's own LOCKED node_modules.
 *
 * Before: it rewrote package.json, deleted the lock and ran `npm install`
 * as root, so the deployed tree resolved fresh from the registry (24 of 101
 * packages differed from the audited lock, some with install scripts), and a
 * hidden-only node reached the registry over the clearnet on every upgrade.
 *
 * Driven for real against this repository's node_modules, with `npm` replaced
 * by a stub that records any call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const work = mkdtempSync(join(tmpdir(), 'morphit-deploy-mcp-'));
const dest = join(work, 'opt-morphit-mcp');
const npmLog = join(work, 'npm.log');
let run: ReturnType<typeof spawnSync>;

beforeAll(() => {
	const bin = join(work, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> '${npmLog}'\nexit 1\n`);
	chmodSync(join(bin, 'npm'), 0o755);
	run = spawnSync(
		'bash',
		[join(REPO, 'ops/scripts/deploy-mcp.sh'), REPO, dest, 'no-such-user-xyz'],
		{
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
			timeout: 240_000
		}
	);
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('deploy-mcp.sh', () => {
	it('runs no npm at all (nothing is resolved from a registry)', () => {
		expect(existsSync(npmLog) ? readFileSync(npmLog, 'utf8') : '').toBe('');
		expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
	});

	it('every deployed package is the version the repository lockfile pins', () => {
		const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as {
			packages: Record<string, { version?: string; link?: boolean }>;
		};
		const nm = join(dest, 'node_modules');
		const names: string[] = [];
		for (const top of existsSync(nm)
			? spawnSync('ls', ['-A', nm], { encoding: 'utf8' }).stdout.split('\n')
			: []) {
			if (top === '' || top === '.bin' || top === '.package-lock.json') continue;
			if (top.startsWith('@')) {
				for (const sub of spawnSync('ls', ['-A', join(nm, top)], { encoding: 'utf8' }).stdout.split(
					'\n'
				)) {
					if (sub !== '') names.push(`${top}/${sub}`);
				}
			} else names.push(top);
		}
		expect(names).toEqual(
			expect.arrayContaining([
				'@modelcontextprotocol/sdk',
				'tsx',
				'zod',
				'@morphit/asset-registry',
				'@morphit/net-defense'
			])
		);
		for (const n of names) {
			if (n.startsWith('@morphit/')) continue;
			const got = (
				JSON.parse(readFileSync(join(nm, n, 'package.json'), 'utf8')) as { version: string }
			).version;
			expect(got, n).toBe(lock.packages[`node_modules/${n}`]?.version);
		}
	});

	it('the runtime starts from the deployed tree alone', () => {
		const r = spawnSync(join(dest, 'node_modules', '.bin', 'tsx'), ['--version'], {
			encoding: 'utf8',
			cwd: dest
		});
		expect(r.status, r.stderr).toBe(0);
		const imp = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				"await import('@modelcontextprotocol/sdk/server/mcp.js'); await import('zod');"
			],
			{ encoding: 'utf8', cwd: dest }
		);
		expect(imp.status, imp.stderr).toBe(0);
	});
});
