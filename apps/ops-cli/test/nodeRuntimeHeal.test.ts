/**
 * An offline install's Node.js runtime: an
 * upgrade from a bundle with a newer vendor/node updates /usr/local, the
 * running binary replaced by rename, and the result is read back.
 * The "node" binaries are small scripts that print a version.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareNodeVersions, healNodeRuntime } from '../src/lib/nodeRuntimeHeal.ts';

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
function box(bundled: string | null, installed: string | null) {
	const d = mkdtempSync(join(tmpdir(), 'noderuntime-'));
	const fake = (p: string, v: string) => {
		mkdirSync(join(p, '..'), { recursive: true });
		writeFileSync(p, `#!/bin/sh\necho ${v}\n`, { mode: 0o755 });
	};
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
	return { installDir: join(d, 'install'), prefix: join(d, 'usr') };
}

describe('the bundled Node runtime', () => {
	it('a newer bundled Node replaces the vendored one, and is read back', async () => {
		const b = box('v22.22.2', 'v22.14.0');
		const r = await healNodeRuntime(ctx, b);
		expect(r).toMatchObject({ strategy: 'updated', verified: true });
		expect(readFileSync(join(b.prefix, 'bin', 'node'), 'utf8')).toMatch(/v22\.22\.2/);
		expect(
			readFileSync(join(b.prefix, 'lib', 'node_modules', 'npm', 'package.json'), 'utf8')
		).toMatch(/new/);
		expect(existsSync(join(b.prefix, 'bin', 'node.new'))).toBe(false);
	});

	it('an equal or newer installed Node, an apt Node, or no bundle: left alone', async () => {
		expect((await healNodeRuntime(ctx, box('v22.14.0', 'v22.22.2'))).strategy).toBe('already');
		expect((await healNodeRuntime(ctx, box('v22.22.2', null))).strategy).toBe('not-vendored');
		expect((await healNodeRuntime(ctx, box(null, 'v22.14.0'))).strategy).toBe('no-bundle');
	});

	it('compares versions numerically', () => {
		expect(compareNodeVersions('v22.9.0', 'v22.14.0')).toBe(-1);
		expect(compareNodeVersions('v22.14.0', 'v22.14.0')).toBe(0);
	});

	it('the upgrade runs it in the self-heal phase', async () => {
		const src = readFileSync(new URL('../src/commands/upgrade.ts', import.meta.url), 'utf8');
		expect(src).toMatch(/\[\s*'the Node runtime update',\s*\(\) => reportHeal\(healNodeRuntime\(/);
	});
});
