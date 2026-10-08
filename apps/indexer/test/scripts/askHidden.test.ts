/**
 * The masked WIF prompt must stay ON SCREEN while it waits.
 *
 * 2026-10-07: anchoring a snapshot, `indexer-snapshot-broadcast.ts --broadcast`
 * showed no prompt at all ("it never asked me for my key"), and what was typed
 * next was read as the key ("Non-base58 character"). readline, on a terminal,
 * moves the cursor to column 1 and clears to the end of the screen right after
 * the prompt was written (ESC[1G ESC[0J), so a prompt that is ONE line, with the
 * cursor still on it, is erased the moment it appears. release-broadcast.ts kept
 * its instructions only because they were on lines above "key> ".
 *
 * Driven through a TTY-shaped input/output pair, and the screen is rendered
 * from every byte written (prompt and readline's own control sequences alike).
 */
import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { askHidden } from '../../scripts/lib/signOnceBroadcast.ts';

/** A tiny terminal: \r, \n, ESC[nG (column), ESC[0J / ESC[J (clear to end of
 *  screen), ESC[K / ESC[0K (clear to end of line); anything else is printed. */
function render(bytes: string): string[] {
	const lines: string[] = [''];
	let row = 0;
	let col = 0;
	const put = (ch: string): void => {
		const l = lines[row] ?? '';
		lines[row] = l.padEnd(col, ' ').slice(0, col) + ch + l.slice(col + 1);
		col++;
	};
	for (let i = 0; i < bytes.length; i++) {
		const c = bytes[i]!;
		if (c === '\r') col = 0;
		else if (c === '\n') {
			row++;
			col = 0;
			if (lines[row] === undefined) lines[row] = '';
		} else if (c === '\x1b' && bytes[i + 1] === '[') {
			const m = /^\x1b\[(\d*)([A-Za-z])/.exec(bytes.slice(i));
			if (!m) continue;
			const n = m[1] === '' ? 0 : Number(m[1]);
			if (m[2] === 'G') col = Math.max(0, (n || 1) - 1);
			else if (m[2] === 'J' && n === 0) {
				lines[row] = (lines[row] ?? '').slice(0, col);
				lines.length = row + 1;
			} else if (m[2] === 'K' && n === 0) lines[row] = (lines[row] ?? '').slice(0, col);
			i += m[0].length - 1;
		} else put(c);
	}
	return lines;
}

function tty() {
	let screen = '';
	const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
	const output = Object.assign(
		new Writable({
			write(chunk, _enc, cb) {
				screen += chunk.toString();
				cb();
			}
		}),
		{ isTTY: true, columns: 120, rows: 40 }
	);
	return { input, output, screen: () => screen };
}

/** Let readline finish what it writes on start (I/O callbacks, no wall-clock wait). */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const PROMPT =
	'Paste the @morphit POSTING WIF (starts with 5; nothing shows as you paste), or blank to abort: ';

describe('askHidden', () => {
	it('a one-line prompt is still on screen while it waits', async () => {
		const t = tty();
		const answer = askHidden(PROMPT, { input: t.input, output: t.output, err: t.output });
		await settle();
		const visible = render(t.screen()).join('\n');
		expect(visible).toContain('Paste the @morphit POSTING WIF');
		t.input.write('5KsecretKey\r');
		expect(await answer).toBe('5KsecretKey');
	});

	it('never shows what is typed', async () => {
		const t = tty();
		const answer = askHidden(PROMPT, { input: t.input, output: t.output, err: t.output });
		await settle();
		t.input.write('5KsecretKey\r');
		await answer;
		expect(t.screen()).not.toContain('5KsecretKey');
	});

	it('input closed before a line (stdin at EOF): resolves with no key instead of hanging', async () => {
		const t = tty();
		const answer = askHidden(PROMPT, { input: t.input, output: t.output, err: t.output });
		await settle();
		t.input.end();
		expect(await answer).toBe('');
	});
});
