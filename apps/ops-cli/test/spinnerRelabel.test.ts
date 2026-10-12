/**
 * v1.21.6 — a long zero-clearnet upgrade moves from step to step: the spinner
 * says what it is doing right now (relabel) and how long the wait has taken,
 * clock first so a label cut to the terminal's width keeps it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDotsSpinner, startPausableSpinner } from '../src/init/spinner.ts';
import { peerDisplayName } from '../src/init/hiddenUpgradeResolve.ts';

afterEach(() => {
	vi.useRealTimers();
});

function fakeOut(): { out: NodeJS.WriteStream; text: () => string } {
	let text = '';
	const out = {
		isTTY: true,
		columns: 100,
		write: (s: string) => {
			text += s;
			return true;
		}
	} as unknown as NodeJS.WriteStream;
	return { out, text: () => text };
}

describe('the pausable spinner', () => {
	it('shows the elapsed time first, follows a relabel, and clears a shorter label’s leftovers', () => {
		vi.useFakeTimers();
		let t = 0;
		const { out, text } = fakeOut();
		const spin = startPausableSpinner('Reading the signed record over Tor/I2P', out, {
			elapsed: true,
			now: () => t
		});
		expect(text()).toMatch(/\r {2}[⠀-⣿] 0:00 · Reading the signed record over Tor\/I2P/);
		t = 65_000;
		spin.relabel('Searching');
		vi.advanceTimersByTime(100);
		expect(text()).toMatch(/\r {2}[⠀-⣿] 1:05 · Searching\u001b\[K/);
		spin.stop();
		expect(text().endsWith('\r\u001b[K\u001b[?25h')).toBe(true);
	});

	it('without `elapsed`, the label is shown as given', () => {
		const { out, text } = fakeOut();
		const spin = startPausableSpinner('Plain', out);
		expect(text()).toMatch(/\r {2}[⠀-⣿] Plain$/);
		spin.stop();
	});
});

// A spinner label naming a peer in a script whose letters are wide
// (East_Asian_Width=W) outside the BMP CJK blocks never takes more than one
// terminal line (a wrapped spinner repeats its line every frame).
// Ranges copied from Unicode 15.1 EastAsianWidth.txt (W), independent of the
// implementation's table; plus the BMP CJK ranges the code already knows.
const WIDE: Array<[number, number]> = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x16fe0, 0x16fe4],
	[0x17000, 0x187f7],
	[0x18800, 0x18cd5],
	[0x1b000, 0x1b122],
	[0x1b170, 0x1b2fb],
	[0x20000, 0x3fffd]
];
const cols = (s: string): number => {
	let n = 0;
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		n += WIDE.some(([a, b]) => c >= a && c <= b) ? 2 : 1;
	}
	return n;
};

function fakeWideTty(columns: number) {
	let text = '';
	const out = {
		isTTY: true,
		columns,
		write: (s: string) => ((text += s), true)
	} as unknown as NodeJS.WriteStream;
	return { out, text: () => text };
}

describe('wide letters outside the BMP CJK blocks', () => {
	for (const [script, first] of [
		['Tangut', 0x17000],
		['Kana Supplement', 0x1b000],
		['Nushu', 0x1b170],
		['Khitan', 0x18b00],
		['Hangul Jamo Extended-A', 0xa960]
	] as const) {
		it(`${script}: the label stays on one line`, () => {
			const name = peerDisplayName({
				name: Array.from({ length: 30 }, (_, i) => String.fromCodePoint(first + i)).join('')
			})!;
			vi.useFakeTimers();
			try {
				const { out, text } = fakeWideTty(80);
				const stop = startDotsSpinner(
					`0:05 · Searching the federation (Tor + I2P): asking ${name} (Tor) · 1/3 asked`,
					out
				);
				vi.advanceTimersByTime(200);
				stop();
				// eslint-disable-next-line no-control-regex
				const frames = text()
					.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
					.split('\r');
				for (const f of frames) expect(cols(f)).toBeLessThanOrEqual(80);
			} finally {
				vi.useRealTimers();
			}
		});
	}
});
