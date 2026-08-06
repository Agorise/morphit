import { describe, expect, it } from 'vitest';
import {
	EDIT_WINDOW_MS,
	editWindowRemainingSeconds,
	withinEditWindow,
	formatRemainingMmSs
} from './editWindow';

const CREATED = '2026-07-09T12:00:00Z';
const t0 = new Date(CREATED).getTime();

describe('editWindowRemainingSeconds', () => {
	it('is the full window at the moment of creation', () => {
		expect(editWindowRemainingSeconds(CREATED, t0)).toBe(EDIT_WINDOW_MS / 1000);
	});

	it('counts down', () => {
		expect(editWindowRemainingSeconds(CREATED, t0 + 60_000)).toBe(14 * 60);
		expect(editWindowRemainingSeconds(CREATED, t0 + 14 * 60_000 + 40_000)).toBe(20);
	});

	it('returns null the instant the window closes (button must vanish)', () => {
		expect(editWindowRemainingSeconds(CREATED, t0 + EDIT_WINDOW_MS)).toBeNull();
		expect(editWindowRemainingSeconds(CREATED, t0 + EDIT_WINDOW_MS + 1)).toBeNull();
	});

	it('rounds up, so the last partial second still shows 1s not 0s', () => {
		expect(editWindowRemainingSeconds(CREATED, t0 + EDIT_WINDOW_MS - 1)).toBe(1);
	});

	it('refuses to date an unparseable order', () => {
		expect(editWindowRemainingSeconds('not-a-date', t0)).toBeNull();
	});
});

describe('withinEditWindow', () => {
	it('tracks the countdown exactly', () => {
		expect(withinEditWindow(CREATED, t0)).toBe(true);
		expect(withinEditWindow(CREATED, t0 + EDIT_WINDOW_MS - 1)).toBe(true);
		expect(withinEditWindow(CREATED, t0 + EDIT_WINDOW_MS)).toBe(false);
	});
});

describe('formatRemainingMmSs', () => {
	it('renders the shape Ken asked for', () => {
		expect(formatRemainingMmSs(260)).toBe('4m 20s');
		expect(formatRemainingMmSs(554)).toBe('9m 14s');
	});

	it('drops the minutes part under a minute', () => {
		expect(formatRemainingMmSs(9)).toBe('9s');
		expect(formatRemainingMmSs(0)).toBe('0s');
	});

	it('matches /my/orders (no zero-padding)', () => {
		expect(formatRemainingMmSs(544)).toBe('9m 4s');
	});

	it('never goes negative', () => {
		expect(formatRemainingMmSs(-5)).toBe('0s');
	});
});
