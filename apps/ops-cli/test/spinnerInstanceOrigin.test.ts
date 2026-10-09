/**
 * syncInstanceOrigin runs `origin-slots.mjs status` and `apply` (up to 300 s)
 * and is called at the terminal by install, edit and upgrade. It shows the
 * spinner its caller hands it (ctx.spinner) for every one of those waits.
 *
 * The `run` seam records each command; the spinner records start and stop, in
 * one shared log, so the test sees the ORDER: spinner started → command ran →
 * spinner stopped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncInstanceOrigin } from '../src/lib/instanceOrigin.ts';

let dir = '';
const saved = { ...process.env };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'origin-spin-'));
	mkdirSync(join(dir, 'apps', 'web', 'scripts'), { recursive: true });
	writeFileSync(join(dir, 'apps', 'web', 'scripts', 'origin-slots.mjs'), '');
	mkdirSync(join(dir, 'build'));
	// Keep the branding lookup inside the temporary tree.
	process.env.MORPHIT_ENV_ROOT = dir;
});
afterEach(() => {
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
});

describe('syncInstanceOrigin shows the spinner it is given while it works', () => {
	it('status and apply each run while a spinner is up, and every spinner is stopped', () => {
		const log: string[] = [];
		let up = 0;
		const ctx = {
			info: () => {},
			warn: () => {},
			spinner: (l: string) => {
				up += 1;
				log.push(`spinner: ${l}`);
				return () => {
					up -= 1;
					log.push('stopped');
				};
			}
		};
		const run = (_cmd: string, args: string[]) => {
			log.push(`run ${args[1]} (spinners up: ${up})`);
			return args[1] === 'status'
				? {
						status: 0,
						stdout: '{"recorded":true,"applied_origin":"-","pending":false}\n',
						stderr: ''
					}
				: { status: 0, stdout: '{"changed":true,"touched":[]}\n', stderr: '' };
		};
		const r = syncInstanceOrigin(ctx, {
			installDir: dir,
			buildDir: join(dir, 'build'),
			origin: { origin: 'https://alice.example', why: 'test' },
			webRoot: null,
			run
		});
		expect(r.strategy).toMatch(/^applied/);
		expect(log).toContain('run status (spinners up: 1)');
		expect(log).toContain('run apply (spinners up: 1)');
		expect(log.find((l) => l.startsWith('spinner: '))).toBeDefined();
		expect(log.indexOf('run status (spinners up: 1)')).toBeGreaterThan(
			log.findIndex((l) => l.startsWith('spinner: '))
		);
		expect(
			log.some((l) => /^spinner: Putting https:\/\/alice\.example on the served pages/.test(l))
		).toBe(true);
		expect(up).toBe(0); // all stopped
		expect(log[log.length - 1]).toBe('stopped');
	});
});
