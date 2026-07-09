import { describe, expect, it } from 'vitest';
import { dayKeyUTC, daySeparatorAt, type DayGroupable } from './daySeparator';

const at = (iso: string): DayGroupable => ({ createdAt: new Date(iso) });
const pending: DayGroupable = { createdAt: null };

describe('dayKeyUTC', () => {
	it('groups by the UTC calendar day, not the local one', () => {
		// 23:59Z and 00:01Z are ~2 minutes apart but different UTC days.
		expect(dayKeyUTC(new Date('2026-07-08T23:59:00Z'))).not.toBe(
			dayKeyUTC(new Date('2026-07-09T00:01:00Z'))
		);
		// Same UTC day, far apart in wall-clock.
		expect(dayKeyUTC(new Date('2026-07-08T00:00:01Z'))).toBe(
			dayKeyUTC(new Date('2026-07-08T23:59:59Z'))
		);
	});

	it('does not collide across months or years with the same day-of-month', () => {
		expect(dayKeyUTC(new Date('2026-07-01T12:00:00Z'))).not.toBe(
			dayKeyUTC(new Date('2026-08-01T12:00:00Z'))
		);
		expect(dayKeyUTC(new Date('2026-01-01T12:00:00Z'))).not.toBe(
			dayKeyUTC(new Date('2027-01-01T12:00:00Z'))
		);
	});
});

describe('daySeparatorAt', () => {
	it('labels the first message in the log', () => {
		const msgs = [at('2026-07-08T10:00:00Z')];
		expect(daySeparatorAt(msgs, 0)).toEqual(new Date('2026-07-08T10:00:00Z'));
	});

	it('returns null within the same day', () => {
		const msgs = [at('2026-07-08T10:00:00Z'), at('2026-07-08T18:30:00Z')];
		expect(daySeparatorAt(msgs, 1)).toBeNull();
	});

	it('labels the first message of a new day', () => {
		const msgs = [at('2026-07-08T23:59:00Z'), at('2026-07-09T00:01:00Z')];
		expect(daySeparatorAt(msgs, 1)).toEqual(new Date('2026-07-09T00:01:00Z'));
	});

	it('never puts a divider above a PENDING message', () => {
		const msgs = [at('2026-07-08T10:00:00Z'), pending];
		expect(daySeparatorAt(msgs, 1)).toBeNull();
	});

	it('a pending message does not make the NEXT confirmed one look like a new day', () => {
		// pending sits between two same-day messages; index 2 must stay quiet.
		const msgs = [at('2026-07-08T10:00:00Z'), pending, at('2026-07-08T11:00:00Z')];
		expect(daySeparatorAt(msgs, 2)).toBeNull();
	});

	it('skips over consecutive pending messages when comparing days', () => {
		const msgs = [at('2026-07-08T10:00:00Z'), pending, pending, at('2026-07-09T09:00:00Z')];
		expect(daySeparatorAt(msgs, 3)).toEqual(new Date('2026-07-09T09:00:00Z'));
	});

	it('a leading pending message gets no divider, and the first confirmed one does', () => {
		const msgs = [pending, at('2026-07-08T10:00:00Z')];
		expect(daySeparatorAt(msgs, 0)).toBeNull();
		expect(daySeparatorAt(msgs, 1)).toEqual(new Date('2026-07-08T10:00:00Z'));
	});

	it('produces exactly one divider per day across a multi-day log', () => {
		const msgs = [
			at('2026-07-06T08:00:00Z'),
			at('2026-07-06T09:00:00Z'),
			at('2026-07-07T10:00:00Z'),
			pending,
			at('2026-07-07T11:00:00Z'),
			at('2026-07-08T12:00:00Z')
		];
		const seps = msgs.map((_, i) => daySeparatorAt(msgs, i)).filter(Boolean);
		expect(seps).toHaveLength(3); // 6th, 7th, 8th
	});

	it('is safe on an out-of-range index', () => {
		expect(daySeparatorAt([], 0)).toBeNull();
		expect(daySeparatorAt([at('2026-07-08T10:00:00Z')], 5)).toBeNull();
	});
});
