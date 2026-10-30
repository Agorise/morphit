/**
 * `branding apply` hands its options to a helper child on stdin. A child that
 * stops before reading them (it failed to start properly, or exited at once)
 * makes that write fail with EPIPE. With no 'error' listener on the child's
 * stdin, that error ended the whole CLI ("write EPIPE", exit 127) instead of
 * being reported as the helper stopping (review v1.21.18).
 *
 * Run in a separate process, as the CLI runs: a helper that exits at once,
 * with options large enough that the write cannot finish before it does.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..');
const BRANDING = join(import.meta.dirname, '..', 'src', 'commands', 'branding.ts');

describe('branding: a helper that stops before reading its input', () => {
	it('is reported as the helper stopping (with its exit code); the CLI itself does not crash', () => {
		const dir = mkdtempSync(join(tmpdir(), 'branding-epipe-'));
		try {
			const script = join(dir, 'run.mts');
			writeFileSync(
				script,
				`const { applyBrandingAsync } = await import(${JSON.stringify(BRANDING)});\n` +
					"process.on('uncaughtException', (e) => { console.log('CRASHED', e.message); process.exit(127); });\n" +
					"const big = 'x'.repeat(8_000_000);\n" +
					"applyBrandingAsync({ buildDir: '/nonexistent', settings: { brandName: null, invalidBrandName: null, shortName: null, dir: big } }, { cmd: 'sh', args: ['-c', 'exit 3'] })\n" +
					"  .then(() => console.log('RESOLVED'), (e) => console.log('REJECTED', e.message));\n"
			);
			const r = spawnSync(join(REPO, 'node_modules/.bin/tsx'), [script], {
				encoding: 'utf8',
				timeout: 60_000
			});
			expect(r.stdout).not.toMatch(/CRASHED/);
			expect(r.status, r.stdout + r.stderr).toBe(0);
			expect(r.stdout).toMatch(
				/REJECTED the branding helper stopped without a result \(exit code 3\)/
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 90_000);
});
