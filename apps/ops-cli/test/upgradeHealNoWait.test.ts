/**
 * Nothing in the upgrade's heal phase waits for the operator, and nothing in
 * it is cut off without a word.
 *
 * On the upgrade TO this release the OLD orchestrator runs the new heals in a
 * child it kills at 300 s; a prompt there either waited for good (the relay
 * log notice used an unbounded y/N) or ate the time the heals after it needed,
 * and a kill was silent. Questions are now left for
 * `sudo morphit-ops upgrade --questions` with a safe default meanwhile, and a
 * killed child names what did not run.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OPS = resolve(HERE, '..');
const TSX = resolve(OPS, '../../node_modules/.bin/tsx');
const UPGRADE = join(OPS, 'src', 'commands', 'upgrade.ts');

describe('the heal phase never waits for an answer', () => {
	it('the relay log notice at a real terminal returns at once and says how to answer later', () => {
		const dir = mkdtempSync(join(tmpdir(), 'heal-nowait-'));
		try {
			const bin = join(dir, 'bin');
			mkdirSync(bin);
			// The relay journal still holds three of the old lines.
			writeFileSync(
				join(bin, 'journalctl'),
				`#!/bin/sh\nprintf '%s\\n' '{"event":"sequential_pattern_rejected","bucketKey":"203.0.113.0/24"}' '{"event":"sequential_pattern_rejected","bucketKey":"198.51.100.0/24"}' '{"event":"sequential_pattern_rejected","bucketKey":"2001:db8::/64"}'\n`
			);
			chmodSync(join(bin, 'journalctl'), 0o755);
			const runner = join(dir, 'run.mts');
			writeFileSync(
				runner,
				`const up = await import(${JSON.stringify(UPGRADE)});\nawait up.healRelayJournalNotice();\nconsole.log('RETURNED');\nprocess.exit(0);\n`
			);
			const marker = join(dir, 'marker');
			const t0 = Date.now();
			// `script` gives the child a real terminal (stdin is a TTY), as an
			// operator running the upgrade by hand has.
			const r = spawnSync('script', ['-qec', `${TSX} ${runner}`, '/dev/null'], {
				encoding: 'utf8',
				timeout: 40_000,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ''}`,
					MORPHIT_JOURNAL_NOTICE_MARKER: marker
				}
			});
			const secs = (Date.now() - t0) / 1000;
			expect(r.stdout, `waited ${secs}s at the prompt: ${r.stdout.slice(-300)}`).toMatch(
				/RETURNED/
			);
			expect(secs).toBeLessThan(30);
			expect(r.stdout).toMatch(/older relay logs hold 3 line/);
			expect(r.stdout).toMatch(/sudo morphit-ops upgrade --questions/);
			expect(existsSync(marker), 'a question nobody answered was recorded as answered').toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it('`upgrade --questions` without a terminal says to run it from one (and changes nothing)', async () => {
		const { runUpgrade } = await import('../src/commands/upgrade.ts');
		const lines: string[] = [];
		const capture = (chunk: unknown): boolean => (lines.push(String(chunk)), true);
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
		const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
		const orig = { restore: () => (out.mockRestore(), err.mockRestore()) };
		const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
		Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
		const savedInstall = process.env.MORPHIT_INSTALL_DIR;
		process.env.MORPHIT_INSTALL_DIR = join(tmpdir(), 'no-such-install-dir');
		try {
			const rc = await runUpgrade({ flags: { questions: 'true' }, positional: [] } as never);
			expect(rc).toBe(2);
			expect(lines.join('\n')).toMatch(/from a terminal/);
		} finally {
			orig.restore();
			if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
			else delete (process.stdin as { isTTY?: boolean }).isTTY;
			if (savedInstall === undefined) delete process.env.MORPHIT_INSTALL_DIR;
			else process.env.MORPHIT_INSTALL_DIR = savedInstall;
		}
	});
});

describe('a heal child stopped by the old upgrader says what did not run', () => {
	it('on SIGTERM it names the step it was in and the ones left, and exits', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'heal-term-'));
		try {
			const runner = join(dir, 'run.mts');
			writeFileSync(
				runner,
				[
					`const up = await import(${JSON.stringify(UPGRADE)});`,
					`if (typeof up.runHealSteps !== 'function') { console.log('NO runHealSteps'); process.exit(3); }`,
					`await up.runHealSteps([`,
					`  ['the quick heal', async () => console.log('QUICK DONE')],`,
					// Inside this step until the test stops the process: it waits for
					// input on stdin, which the test never writes (no timer involved).
					`  ['the slow heal', () => (console.log('SLOW STARTED'), new Promise((r) => process.stdin.once('data', r)))],`,
					`  ['the last heal', async () => console.log('LAST DONE')]`,
					`], { child: true });`,
					`console.log('FINISHED');`
				].join('\n')
			);
			const child = spawn(TSX, [runner], { stdio: ['pipe', 'pipe', 'pipe'] });
			const closed = new Promise<number | null>((res) => child.on('close', (c) => res(c)));
			let out = '';
			let seen = (): void => undefined;
			const onData = (d: Buffer): void => {
				out += d;
				if (/SLOW STARTED|NO runHealSteps/.test(out)) seen();
			};
			child.stdout.on('data', onData);
			child.stderr.on('data', onData);
			// Stop it only once it is inside the slow step (or has already ended).
			await Promise.race([new Promise<void>((res) => (seen = res)), closed]);
			child.kill('SIGTERM');
			const code = await closed;
			expect(out).not.toMatch(/NO runHealSteps/);
			expect(out).not.toMatch(/LAST DONE|FINISHED/);
			expect(out).toMatch(/the slow heal/);
			expect(out).toMatch(/the last heal/);
			expect(out).toMatch(/sudo morphit-ops upgrade/);
			expect(code).not.toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
