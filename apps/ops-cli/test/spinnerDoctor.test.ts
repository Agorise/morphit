/**
 * `morphit-ops doctor` runs each service's `npm start -- --check-config` (up to
 * 20 s each) and the indexer's `--check-schema`. The operator waits at the
 * terminal through all three, so the braille spinner is on the line for each
 * and TURNS while it runs (a blocking spawnSync froze the screen on
 * "checking indexer…"). Under --json, stdout stays pure JSON.
 *
 * `npm` is a stand-in on PATH that copies what the fake terminal shows when it
 * is started, then takes a moment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { currentLine, fakeTerminal, frameRe, type FakeTerminal } from './helpers/screen.ts';
import { spinnerFrames } from './helpers/pty.ts';

let dir = '';
vi.mock('../src/lib/repoRoot.ts', async (orig) => ({
	...(await orig<typeof import('../src/lib/repoRoot.ts')>()),
	safeCwd: () => join(dir, 'install')
}));

const { runDoctor } = await import('../src/commands/doctor.ts');

let term: FakeTerminal | null = null;
const PATH = process.env.PATH;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'doctor-spin-'));
	mkdirSync(join(dir, 'install', 'apps', 'indexer'), { recursive: true });
	mkdirSync(join(dir, 'install', 'apps', 'relay'), { recursive: true });
	mkdirSync(join(dir, 'bin'));
	writeFileSync(join(dir, 'screen'), '');
	writeFileSync(
		join(dir, 'bin', 'npm'),
		[
			'#!/bin/sh',
			`D=${dir}`,
			'n=$(cat "$D/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/n"',
			'cp "$D/screen" "$D/at-$n"',
			'sleep 0.4',
			'echo "[check-schema] schema is current"',
			'exit 0',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${join(dir, 'bin')}:${PATH}`;
});
afterEach(() => {
	term?.restore();
	term = null;
	process.env.PATH = PATH;
	rmSync(dir, { recursive: true, force: true });
});

describe("doctor's slow checks show the turning spinner", () => {
	it('config check of each service and the schema check: spinner on the line, turning', async () => {
		term = fakeTerminal({ mirror: join(dir, 'screen') });
		const code = await runDoctor({
			flags: { 'no-rpc': 'true' },
			positional: [],
			colorEnabled: false
		});
		const screen = term.out();
		term.restore();
		term = null;
		expect(code).toBe(0);
		const at = (n: number): string => currentLine(readFileSync(join(dir, `at-${n}`), 'utf8'));
		expect(at(1)).toMatch(frameRe("Checking the indexer's config (up to 20 s)…"));
		expect(at(2)).toMatch(frameRe("Checking the relay's config (up to 20 s)…"));
		expect(at(3)).toMatch(frameRe('Checking the database schema (up to 20 s)…'));
		// Each ~0.4 s run turned the dots several times.
		expect(
			spinnerFrames(screen, "Checking the indexer's config (up to 20 s)…")
		).toBeGreaterThanOrEqual(3);
		expect(
			spinnerFrames(screen, 'Checking the database schema (up to 20 s)…')
		).toBeGreaterThanOrEqual(3);
	}, 30_000);

	it('--json: stdout is only the JSON document; the spinner went to stderr', async () => {
		term = fakeTerminal();
		await runDoctor({
			flags: { 'no-rpc': 'true', json: 'true' },
			positional: [],
			colorEnabled: false
		});
		const out = term.out();
		const err = term.err();
		term.restore();
		term = null;
		expect(() => JSON.parse(out)).not.toThrow();
		expect(/[⠀-⣿]/.test(out)).toBe(false);
		expect(
			spinnerFrames(err, "Checking the indexer's config (up to 20 s)…")
		).toBeGreaterThanOrEqual(1);
	}, 30_000);
});
