/**
 * The one-time relay-log notice (heal, operator-confirmed): it never
 * touches the journal without a yes, verifies by counting again, and asks once.
 */
import { describe, it, expect } from 'vitest';
import { relayJournalNotice, type JournalNoticeRuntime } from '../src/lib/journalNotice.ts';

function rt(o: {
	lines: number | null;
	answer: boolean | null;
	marker?: boolean;
	vacuumClears?: boolean;
}) {
	let lines = o.lines;
	const log: string[] = [];
	const state = { vacuumed: 0, marker: o.marker ? 'x' : (null as string | null), asked: 0 };
	const r: JournalNoticeRuntime = {
		count: () => lines,
		vacuum: () => {
			state.vacuumed++;
			if (o.vacuumClears !== false) lines = 0;
			return true;
		},
		ask: async () => {
			state.asked++;
			return o.answer;
		},
		markerExists: () => state.marker !== null,
		writeMarker: (t) => void (state.marker = t),
		info: (m) => void log.push(m),
		warn: (m) => void log.push(`WARN ${m}`),
		spinner: () => () => undefined
	};
	return { r, state, log };
}

describe('relay journal notice', () => {
	it('no such line → remembers, says nothing, asks nothing', async () => {
		const t = rt({ lines: 0, answer: true });
		expect(await relayJournalNotice(t.r)).toBe('nothing-found');
		expect(t.state.asked + t.state.vacuumed).toBe(0);
		expect(t.state.marker).not.toBeNull();
		expect(t.log).toEqual([]);
	});
	it('lines found + no → journal untouched, never asked again', async () => {
		const t = rt({ lines: 3, answer: false });
		expect(await relayJournalNotice(t.r)).toBe('declined');
		expect(t.state.vacuumed).toBe(0);
		expect(await relayJournalNotice(t.r)).toBe('already-handled');
		expect(t.state.asked).toBe(1);
	});
	it('lines found + yes → vacuumed and verified by counting again', async () => {
		const t = rt({ lines: 3, answer: true });
		expect(await relayJournalNotice(t.r)).toBe('vacuumed');
		expect(t.state.vacuumed).toBe(1);
	});
	it('a vacuum that leaves lines is reported, not claimed', async () => {
		const t = rt({ lines: 3, answer: true, vacuumClears: false });
		expect(await relayJournalNotice(t.r)).toBe('vacuum-incomplete');
		expect(t.state.marker).toBeNull();
	});
	it('no terminal → nothing changed and the question waits', async () => {
		const t = rt({ lines: 3, answer: null });
		expect(await relayJournalNotice(t.r)).toBe('not-asked');
		expect(t.state.vacuumed).toBe(0);
		expect(t.state.marker).toBeNull();
	});
});
