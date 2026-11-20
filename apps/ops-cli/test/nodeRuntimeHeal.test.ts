/**
 * The /usr/local Node.js runtime of a server installed from a bundle: an
 * upgrade from a bundle with a newer vendor/node updates /usr/local, the
 * running binary replaced by rename, and the result is read back.
 *
 * v1.24.8: without such a bundle (every normal release), the Node the release
 * names is downloaded from nodejs.org — directly, else through Tor; through Tor
 * only on a zero-clearnet server — kept only when its SHA-256 is the release's,
 * unpacked (a real .tar.xz here), and put in place the same way.
 * The "node" binaries are small scripts that print a version.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	NODE_RUNTIME,
	compareNodeVersions,
	healNodeRuntime,
	nodeTarballUrl
} from '../src/lib/nodeRuntimeHeal.ts';

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
const fake = (p: string, v: string) => {
	mkdirSync(join(p, '..'), { recursive: true });
	writeFileSync(p, `#!/bin/sh\necho ${v}\n`, { mode: 0o755 });
};
function box(bundled: string | null, installed: string | null) {
	const d = mkdtempSync(join(tmpdir(), 'noderuntime-'));
	if (bundled) {
		fake(join(d, 'install', 'vendor', 'node', 'bin', 'node'), bundled);
		writeFileSync(join(d, 'install', 'vendor', 'node', 'bin', 'npm'), 'npm-new');
		mkdirSync(join(d, 'install', 'vendor', 'node', 'lib', 'node_modules', 'npm'), {
			recursive: true
		});
		writeFileSync(
			join(d, 'install', 'vendor', 'node', 'lib', 'node_modules', 'npm', 'package.json'),
			'{"version":"new"}'
		);
	}
	if (installed) fake(join(d, 'usr', 'bin', 'node'), installed);
	return {
		root: d,
		installDir: join(d, 'install'),
		prefix: join(d, 'usr'),
		workDir: join(d, 'work')
	};
}

/** A real node-<v>-linux-x64.tar.xz whose node prints `reports`. */
function tarball(version: string, reports = version): { file: string; sha: string } {
	const d = mkdtempSync(join(tmpdir(), 'nodetar-'));
	const name = `node-${version}-linux-x64`;
	fake(join(d, name, 'bin', 'node'), reports);
	mkdirSync(join(d, name, 'lib', 'node_modules', 'npm'), { recursive: true });
	writeFileSync(
		join(d, name, 'lib', 'node_modules', 'npm', 'package.json'),
		`{"version":"${version}"}`
	);
	const file = join(d, `${name}.tar.xz`);
	execFileSync('tar', ['-cJf', file, '-C', d, name]);
	return { file, sha: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

/** A download that serves `file` on the routes given, and records each try. */
function server(file: string | null, routes: { direct: boolean; tor: boolean }) {
	const tries: Array<{ url: string; viaTor: boolean }> = [];
	return {
		tries,
		download: async (url: string, dest: string, viaTor: boolean) => {
			tries.push({ url, viaTor });
			if (file === null || !(viaTor ? routes.tor : routes.direct)) return false;
			writeFileSync(dest, readFileSync(file));
			return true;
		}
	};
}

describe('the bundled Node runtime', () => {
	it('a bundled Node at least as new as the release names replaces the vendored one, and is read back; nothing downloaded', async () => {
		const b = box('v22.22.2', 'v22.14.0');
		const s = server(null, { direct: true, tor: true });
		const r = await healNodeRuntime(ctx, {
			...b,
			runtime: { version: 'v22.22.2', sha256: { x64: 'x', arm64: 'y' } },
			download: s.download
		});
		expect(r).toMatchObject({ strategy: 'updated', verified: true });
		expect(readFileSync(join(b.prefix, 'bin', 'node'), 'utf8')).toMatch(/v22\.22\.2/);
		expect(
			readFileSync(join(b.prefix, 'lib', 'node_modules', 'npm', 'package.json'), 'utf8')
		).toMatch(/new/);
		expect(existsSync(join(b.prefix, 'bin', 'node.new'))).toBe(false);
		expect(s.tries).toEqual([]);
	});

	it('an installed Node already at the release one, or an apt Node: left alone', async () => {
		const pin = { version: 'v22.22.2', sha256: { x64: 'x', arm64: 'y' } };
		expect(
			await healNodeRuntime(ctx, { ...box('v22.14.0', 'v22.22.2'), runtime: pin })
		).toMatchObject({
			strategy: 'already',
			routine: true
		});
		expect((await healNodeRuntime(ctx, { ...box('v22.22.2', null), runtime: pin })).strategy).toBe(
			'not-vendored'
		);
	});

	it('compares versions numerically', () => {
		expect(compareNodeVersions('v22.9.0', 'v22.14.0')).toBe(-1);
		expect(compareNodeVersions('v22.14.0', 'v22.14.0')).toBe(0);
	});

	it('the upgrade runs it in the self-heal phase, restarting the services itself only for --heals', async () => {
		const src = readFileSync(new URL('../src/commands/upgrade.ts', import.meta.url), 'utf8');
		expect(src).toMatch(
			/\[\s*'the Node runtime update',\s*\(\) =>\s*reportHeal\(\s*healNodeRuntime\(/
		);
		expect(src).toMatch(
			/\.\.\.\(servicesAlreadyRunning\s*\?\s*\{ restartServices: \(\) => runNodeRestartScript\(selfHealInstallDir\(\)\) \}/
		);
		expect(src).toMatch(/servicesAlreadyRunning = true;\s*try \{\s*await runHealSteps\(/);
	});
});

describe("the release's Node from nodejs.org (no bundle brings it)", () => {
	const V = 'v22.23.5';
	const pinFor = (sha: string) => ({ version: V, sha256: { x64: sha, arm64: 'none' } });

	it("morphitir's case (22.14.0, no bundle): downloaded directly, checked, unpacked, put in place; the work folder is gone", async () => {
		const b = box(null, 'v22.14.0');
		const inodeBefore = statSync(join(b.prefix, 'bin', 'node')).ino;
		const t = tarball(V);
		const s = server(t.file, { direct: true, tor: true });
		const r = await healNodeRuntime(ctx, {
			...b,
			runtime: pinFor(t.sha),
			arch: 'x64',
			hiddenOnly: () => false,
			download: s.download
		});
		expect(r).toMatchObject({ strategy: 'downloaded', verified: true });
		// Renamed over (a running Node keeps its old file): a new file, not the old one rewritten.
		expect(statSync(join(b.prefix, 'bin', 'node')).ino).not.toBe(inodeBefore);
		expect(r.detail).toBe(
			`Node runtime: ${join(b.prefix, 'bin', 'node')} updated v22.14.0 → ${V} (from nodejs.org, its SHA-256 checked); the services restart on it with this upgrade.`
		);
		expect(s.tries).toEqual([{ url: nodeTarballUrl(V, 'x64'), viaTor: false }]);
		expect(readFileSync(join(b.prefix, 'bin', 'node'), 'utf8')).toContain(V);
		expect(
			readFileSync(join(b.prefix, 'lib', 'node_modules', 'npm', 'package.json'), 'utf8')
		).toContain(V);
		expect(existsSync(b.workDir)).toBe(false);
	});

	it('nodejs.org refused directly: through Tor (said); a zero-clearnet server tries Tor only', async () => {
		const t = tarball(V);
		const b = box(null, 'v22.22.2');
		const s = server(t.file, { direct: false, tor: true });
		const r = await healNodeRuntime(ctx, {
			...b,
			runtime: pinFor(t.sha),
			arch: 'x64',
			hiddenOnly: () => false,
			download: s.download
		});
		expect(s.tries.map((x) => x.viaTor)).toEqual([false, true]);
		expect(r.detail).toContain('from nodejs.org through Tor');
		const h = box(null, 'v22.22.2');
		const hs = server(t.file, { direct: true, tor: true });
		await healNodeRuntime(ctx, {
			...h,
			runtime: pinFor(t.sha),
			arch: 'x64',
			hiddenOnly: () => true,
			download: hs.download
		});
		expect(hs.tries.map((x) => x.viaTor)).toEqual([true]);
	});

	it('restarts the services itself when asked (upgrade --heals), after the new Node is read back', async () => {
		const b = box(null, 'v22.22.2');
		const t = tarball(V);
		const seen: string[] = [];
		const r = await healNodeRuntime(ctx, {
			...b,
			runtime: pinFor(t.sha),
			arch: 'x64',
			hiddenOnly: () => false,
			download: server(t.file, { direct: true, tor: true }).download,
			restartServices: async () => {
				seen.push(readFileSync(join(b.prefix, 'bin', 'node'), 'utf8'));
			}
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain(V);
		expect(r.detail).toContain('the Morphit services were restarted onto it');
	});

	it('a file that is not the one the release names is thrown away; nothing changes', async () => {
		const b = box(null, 'v22.14.0');
		const t = tarball(V);
		let restarted = false;
		const r = await healNodeRuntime(ctx, {
			...b,
			runtime: pinFor('0'.repeat(64)),
			arch: 'x64',
			hiddenOnly: () => false,
			download: server(t.file, { direct: true, tor: true }).download,
			restartServices: async () => {
				restarted = true;
			}
		});
		expect(r).toMatchObject({ strategy: 'checksum-mismatch', verified: false });
		expect(readFileSync(join(b.prefix, 'bin', 'node'), 'utf8')).toContain('v22.14.0');
		expect(existsSync(b.workDir)).toBe(false);
		expect(restarted).toBe(false);
	});

	it('a Node inside that reports another version is not put in place', async () => {
		const b = box(null, 'v22.14.0');
		const t = tarball(V, 'v22.0.0');
		const r = await healNodeRuntime(ctx, {
			...b,
			runtime: pinFor(t.sha),
			arch: 'x64',
			hiddenOnly: () => false,
			download: server(t.file, { direct: true, tor: true }).download
		});
		expect(r).toMatchObject({ strategy: 'unpack-failed', verified: false });
		expect(r.detail).toContain('the Node inside reports v22.0.0');
		expect(readFileSync(join(b.prefix, 'bin', 'node'), 'utf8')).toContain('v22.14.0');
	});

	it('nodejs.org unreachable both ways: said calmly with the command; nothing changes', async () => {
		const b = box(null, 'v22.14.0');
		const r = await healNodeRuntime(ctx, {
			...b,
			runtime: pinFor('x'),
			arch: 'x64',
			hiddenOnly: () => false,
			download: server(null, { direct: false, tor: false }).download
		});
		expect(r).toMatchObject({ strategy: 'download-failed', verified: false });
		expect(r.detail).toContain('directly or through Tor');
		expect(r.detail).toContain('sudo morphit-ops upgrade --heals');
	});

	it('a bundle older than the release Node: the release one is downloaded', async () => {
		const b = box('v22.22.2', 'v22.14.0');
		const t = tarball(V);
		const s = server(t.file, { direct: true, tor: true });
		const r = await healNodeRuntime(ctx, {
			...b,
			runtime: pinFor(t.sha),
			arch: 'x64',
			hiddenOnly: () => false,
			download: s.download
		});
		expect(r.strategy).toBe('downloaded');
		expect(readFileSync(join(b.prefix, 'bin', 'node'), 'utf8')).toContain(V);
	});

	it('an architecture nodejs.org is not asked for: said, nothing downloaded', async () => {
		const s = server(null, { direct: true, tor: true });
		const r = await healNodeRuntime(ctx, {
			...box(null, 'v22.14.0'),
			runtime: pinFor('x'),
			arch: 'ppc64',
			hiddenOnly: () => false,
			download: s.download
		});
		expect(r.strategy).toBe('unsupported-arch');
		expect(s.tries).toEqual([]);
	});
});

describe("the release's Node pin", () => {
	it('is the version the offline bundle carries, with a SHA-256 for each architecture', () => {
		const sh = readFileSync(
			new URL('../../../scripts/build-offline-bundle.sh', import.meta.url),
			'utf8'
		);
		expect(/^NODE_VERSION="(v\d+\.\d+\.\d+)"$/m.exec(sh)?.[1]).toBe(NODE_RUNTIME.version);
		expect(NODE_RUNTIME.sha256.x64).toMatch(/^[0-9a-f]{64}$/);
		expect(NODE_RUNTIME.sha256.arm64).toMatch(/^[0-9a-f]{64}$/);
		expect(NODE_RUNTIME.sha256.x64).not.toBe(NODE_RUNTIME.sha256.arm64);
	});
});
