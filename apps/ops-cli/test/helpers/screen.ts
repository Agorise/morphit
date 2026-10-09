/**
 * A fake terminal for in-process tests of what an operator SEES while the CLI
 * waits: process.stdout (and stderr) report a TTY and every write is recorded,
 * in order, so a test can ask "was the braille spinner with this label on the
 * line at the moment X happened?".
 */
import { appendFileSync } from 'node:fs';
import { format } from 'node:util';
import { vi } from 'vitest';

/** A braille frame drawn beside `label` at the start of the line. */
export function frameRe(label: string): RegExp {
	const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\r {2}[\\u2800-\\u28ff] ${esc}`);
}

/** The spinner's line clear. */
export const CLEAR = '\r\u001b[K';

/** What is on the current line: everything after the last line clear. */
export function currentLine(screen: string): string {
	const i = screen.lastIndexOf(CLEAR);
	return i === -1 ? screen : screen.slice(i + CLEAR.length);
}

export interface FakeTerminal {
	/** Everything written to stdout. */
	readonly out: () => string;
	/** Everything written to stderr. */
	readonly err: () => string;
	readonly restore: () => void;
}

/** Make stdout/stderr look like a terminal and record what is written.
 *  `mirror`: also append every stdout write to this file (synchronously), so a
 *  stand-in command run by the code under test can see the screen. */
export function fakeTerminal(opts: { mirror?: string; tty?: boolean } = {}): FakeTerminal {
	let out = '';
	let err = '';
	const tty = opts.tty ?? true;
	const prevOut = process.stdout.isTTY;
	const prevErr = process.stderr.isTTY;
	process.stdout.isTTY = tty;
	process.stderr.isTTY = tty;
	const toOut = (chunk: unknown): boolean => {
		out += String(chunk);
		if (opts.mirror !== undefined) appendFileSync(opts.mirror, String(chunk));
		return true;
	};
	const toErr = (chunk: unknown): boolean => {
		err += String(chunk);
		return true;
	};
	const o = vi.spyOn(process.stdout, 'write').mockImplementation(toOut as never);
	const e = vi.spyOn(process.stderr, 'write').mockImplementation(toErr as never);
	// vitest routes console.* to its reporter, not through process.stdout.
	const l = vi
		.spyOn(console, 'log')
		.mockImplementation((...a: unknown[]) => void toOut(`${format(...a)}\n`));
	const ce = vi
		.spyOn(console, 'error')
		.mockImplementation((...a: unknown[]) => void toErr(`${format(...a)}\n`));
	return {
		out: () => out,
		err: () => err,
		restore: () => {
			o.mockRestore();
			e.mockRestore();
			l.mockRestore();
			ce.mockRestore();
			process.stdout.isTTY = prevOut;
			process.stderr.isTTY = prevErr;
		}
	};
}
