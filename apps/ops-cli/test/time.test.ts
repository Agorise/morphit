/**
 * Morphit ops CLI — time helper smokes.
 *
 * parseDurationSpec and formatDuration are core to every
 * subcommand that takes --since or --age, and to the status
 * dashboard's age formatting.  Bugs here mean every command
 * silently misbehaves.
 */

import { describe, it, expect } from 'vitest';
import {
	parseDurationSpec,
	formatDuration,
	relativeTime,
	ageSeconds,
	utcMidnightToday
} from '../src/lib/time.ts';

describe('parseDurationSpec', () => {
	it('parses seconds', () => {
		expect(parseDurationSpec('30s')).toBe(30);
		expect(parseDurationSpec('0s')).toBe(0);
	});
	it('parses minutes', () => {
		expect(parseDurationSpec('5m')).toBe(300);
	});
	it('parses hours', () => {
		expect(parseDurationSpec('1h')).toBe(3600);
		expect(parseDurationSpec('24h')).toBe(86400);
	});
	it('parses days', () => {
		expect(parseDurationSpec('7d')).toBe(7 * 86400);
	});
	it('accepts whitespace between number and unit', () => {
		expect(parseDurationSpec('5 m')).toBe(300);
		expect(parseDurationSpec('1  h')).toBe(3600);
	});
	it('is case-insensitive on the unit', () => {
		expect(parseDurationSpec('5M')).toBe(300);
		expect(parseDurationSpec('1H')).toBe(3600);
		expect(parseDurationSpec('1D')).toBe(86400);
	});
	it('rejects invalid formats', () => {
		expect(parseDurationSpec('')).toBeNull();
		expect(parseDurationSpec('5')).toBeNull();
		expect(parseDurationSpec('m')).toBeNull();
		expect(parseDurationSpec('5x')).toBeNull();
		expect(parseDurationSpec('-5m')).toBeNull();
		expect(parseDurationSpec('abc')).toBeNull();
		expect(parseDurationSpec('5min')).toBeNull(); // unit must be 1 char
	});
});

describe('formatDuration', () => {
	it('handles zero and negative', () => {
		expect(formatDuration(0)).toBe('0s');
		expect(formatDuration(-1)).toBe('0s');
	});
	it('formats sub-minute durations as seconds only', () => {
		expect(formatDuration(1)).toBe('1s');
		expect(formatDuration(59)).toBe('59s');
	});
	it('formats minute durations with seconds when nonzero', () => {
		expect(formatDuration(60)).toBe('1m');
		expect(formatDuration(90)).toBe('1m 30s');
		expect(formatDuration(125)).toBe('2m 5s');
	});
	it('formats hour durations with minutes when nonzero', () => {
		expect(formatDuration(3600)).toBe('1h');
		expect(formatDuration(3660)).toBe('1h 1m');
		expect(formatDuration(7320)).toBe('2h 2m');
	});
	it('formats day durations with hours when nonzero', () => {
		expect(formatDuration(86400)).toBe('1d');
		expect(formatDuration(86400 + 3600)).toBe('1d 1h');
		expect(formatDuration(86400 * 3 + 3600 * 5)).toBe('3d 5h');
	});
	it('floors fractional input', () => {
		expect(formatDuration(59.9)).toBe('59s');
		expect(formatDuration(120.7)).toBe('2m');
	});
});

describe('relativeTime', () => {
	const now = new Date('2026-04-26T12:00:00Z');
	it('reports just now for sub-5s deltas', () => {
		expect(relativeTime(new Date('2026-04-26T11:59:58Z'), now)).toBe('just now');
	});
	it('reports seconds ago', () => {
		expect(relativeTime(new Date('2026-04-26T11:59:30Z'), now)).toBe('30s ago');
	});
	it('reports minutes ago', () => {
		expect(relativeTime(new Date('2026-04-26T11:55:00Z'), now)).toBe('5m ago');
	});
	it('reports hours ago', () => {
		expect(relativeTime(new Date('2026-04-26T08:00:00Z'), now)).toBe('4h ago');
	});
	it('reports days ago', () => {
		expect(relativeTime(new Date('2026-04-23T12:00:00Z'), now)).toBe('3d ago');
	});
	it('reports months ago', () => {
		expect(relativeTime(new Date('2026-02-01T00:00:00Z'), now)).toBe('2mo ago');
	});
	it('handles future dates gracefully', () => {
		expect(relativeTime(new Date('2026-04-26T12:01:00Z'), now)).toBe('in the future');
	});
});

describe('ageSeconds', () => {
	it('returns positive seconds since the given Date', () => {
		const now = new Date('2026-04-26T12:00:00Z');
		const then = new Date('2026-04-26T11:59:30Z');
		expect(ageSeconds(then, now)).toBe(30);
	});
	it('floors to integer seconds', () => {
		const now = new Date('2026-04-26T12:00:00.500Z');
		const then = new Date('2026-04-26T11:59:59.000Z');
		expect(ageSeconds(then, now)).toBe(1);
	});
});

describe('utcMidnightToday', () => {
	it('returns UTC 00:00:00 for the date of `now`', () => {
		const now = new Date('2026-04-26T15:30:00Z');
		const midnight = utcMidnightToday(now);
		expect(midnight.toISOString()).toBe('2026-04-26T00:00:00.000Z');
	});
	it('handles late-evening UTC correctly', () => {
		const now = new Date('2026-04-26T23:59:59Z');
		const midnight = utcMidnightToday(now);
		expect(midnight.toISOString()).toBe('2026-04-26T00:00:00.000Z');
	});
});
