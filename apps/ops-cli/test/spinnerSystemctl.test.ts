/**
 * The interactive service toggles an operator runs at the terminal as root —
 * `edit` / `alt-address` offering a restart (lib/restartServices.ts) and
 * `morphit-ops mcp` enabling or disabling its unit — show the braille spinner
 * while systemctl works, and it turns (systemctl runs without blocking).
 *
 * `systemctl` is a stand-in on PATH that copies what the fake terminal shows
 * when it runs, then takes a moment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { currentLine, fakeTerminal, frameRe, type FakeTerminal } from './helpers/screen.ts';
import { spinnerFrames } from './helpers/pty.ts';
import { offerRestart } from '../src/lib/restartServices.ts';
import { runMcp } from '../src/commands/mcp.ts';

let dir = '';
let term: FakeTerminal | null = null;
const PATH = process.env.PATH;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'systemctl-spin-'));
	writeFileSync(join(dir, 'screen'), '');
	writeFileSync(
		join(dir, 'systemctl'),
		[
			'#!/bin/sh',
			`cp '${join(dir, 'screen')}' '${join(dir, 'at-systemctl')}'`,
			'sleep 0.5',
			'exit 0',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${dir}:${PATH}`;
	// As root: the spinner is never put over a sudo password prompt.
	vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
	term = fakeTerminal({ mirror: join(dir, 'screen') });
});
afterEach(() => {
	term?.restore();
	term = null;
	process.env.PATH = PATH;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

const atSystemctl = (): string => currentLine(readFileSync(join(dir, 'at-systemctl'), 'utf8'));

describe('systemctl at the terminal shows the turning spinner', () => {
	it('offerRestart: restarting the indexer', async () => {
		const ok = await offerRestart(['morphit-indexer'], { confirm: async () => true });
		const screen = term!.out();
		expect(ok).toBe(true);
		expect(atSystemctl()).toMatch(frameRe('Restarting indexer…'));
		expect(spinnerFrames(screen, 'Restarting indexer…')).toBeGreaterThanOrEqual(3);
	}, 30_000);

	it('mcp: enabling the MCP server', async () => {
		const code = await runMcp(
			{ flags: {}, positional: [], colorEnabled: false },
			{ readState: () => 'inactive', confirm: async () => true }
		);
		const screen = term!.out();
		expect(code).toBe(0);
		expect(atSystemctl()).toMatch(frameRe('Enabling and starting the MCP server…'));
		expect(spinnerFrames(screen, 'Enabling and starting the MCP server…')).toBeGreaterThanOrEqual(
			3
		);
	}, 30_000);
});
