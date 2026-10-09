/**
 * fast-sync stops the running indexer, waits for it to exit (up to ~20 s), and
 * starts it again. The operator sits at the terminal through all of it, so the
 * braille spinner must be on the line for the whole stop, wait and start — and
 * it must TURN during the wait (a blocking spawnSync loop froze it).
 *
 * `systemctl` is a stand-in on PATH that, when asked to stop or start, copies
 * what the fake terminal shows at that moment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { currentLine, fakeTerminal, frameRe, CLEAR, type FakeTerminal } from './helpers/screen.ts';
import { spinnerFrames } from './helpers/pty.ts';

vi.mock('../src/init/prompt.ts', async (orig) => ({
	...(await orig<typeof import('../src/init/prompt.ts')>()),
	askYesNo: async () => true, // "stop it now?" — yes
	ask: async () => 'no' // "type fast-sync" — no: abort, and the indexer is started again
}));

const { runFastSync } = await import('../src/commands/fastSync.ts');

let dir = '';
let term: FakeTerminal | null = null;
const PATH = process.env.PATH;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fastsync-spin-'));
	writeFileSync(join(dir, 'screen'), '');
	writeFileSync(
		join(dir, 'systemctl'),
		[
			'#!/bin/sh',
			`D=${dir}`,
			'case "$1" in',
			'  is-active) n=$(cat "$D/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/n";',
			'             if [ $n -le 2 ]; then echo active; else echo inactive; fi ;;',
			'  stop) cp "$D/screen" "$D/at-stop" ;;',
			'  start) cp "$D/screen" "$D/at-start" ;;',
			'esac',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${dir}:${PATH}`;
	// The spinner runs systemctl itself only as root (polkit may prompt otherwise).
	vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
});
afterEach(() => {
	term?.restore();
	term = null;
	process.env.PATH = PATH;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe('fast-sync: the indexer stop, wait and start show the turning spinner', () => {
	it('spinner on the line during the stop, turning while it waits, on the line during the start', async () => {
		term = fakeTerminal({ mirror: join(dir, 'screen') });
		const db = {
			query: async () => ({ rows: [{ last_applied_block: '0', last_applied_at: null }] }),
			close: async () => {}
		};
		const code = await runFastSync({
			db: db as never,
			config: {} as never,
			flags: {},
			positional: []
		});
		const screen = term.out();
		term.restore();
		term = null;
		expect(code).toBe(1); // aborted at the confirmation, as scripted

		// While systemctl stop ran, the spinner was the current line.
		const atStop = currentLine(readFileSync(join(dir, 'at-stop'), 'utf8'));
		expect(atStop).toMatch(frameRe('Stopping the indexer…'));
		// While it polled for the indexer to exit (~1 s here), the dots turned.
		expect(spinnerFrames(screen, 'Waiting for the indexer to stop…')).toBeGreaterThanOrEqual(3);
		// "Indexer stopped." comes after the spinner line was cleared.
		const stopped = screen.indexOf('Indexer stopped.');
		expect(stopped).toBeGreaterThan(-1);
		expect(screen.lastIndexOf(CLEAR, stopped)).toBeGreaterThan(
			screen.lastIndexOf('Waiting for the indexer to stop…', stopped)
		);
		// While systemctl start ran, the spinner was the current line.
		const atStart = currentLine(readFileSync(join(dir, 'at-start'), 'utf8'));
		expect(atStart).toMatch(frameRe('Starting the indexer again…'));
		// And the line is cleared at the end.
		expect(screen.endsWith('\u001b[?25h')).toBe(true);
	}, 30_000);
});
