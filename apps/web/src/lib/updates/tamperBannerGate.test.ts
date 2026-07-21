// @vitest-environment jsdom
/**
 * cp514 (t.txt A) — the "Build integrity check failed" banner still flashed on
 * some devices during a routine upgrade, BEFORE the friendly "Load it now"
 * snackbar could appear. These gates suppress the scary asset-tamper banner
 * while a new build is landing (swUpdatePending) and for a short grace window
 * after boot (tamperGraceElapsed) so the update path wins the race. A genuine
 * same-version tamper on a fully-settled bundle still fires once these clear.
 *
 * Belt-and-suspenders means these gates only ever SUPPRESS — they must never
 * force the banner on, so their "safe" resting state is false.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { swUpdatePending, tamperGraceElapsed, TAMPER_BANNER_GRACE_MS } from './tamperBannerGate';

describe('cp514 (t.txt A) — tamper-banner suppression gates', () => {
	afterEach(() => vi.useRealTimers());

	it('swUpdatePending resting-false when no service worker is available', () => {
		// On a no-SW browser the banner must behave exactly as before: the gate
		// resolves false (no pending update) and suppresses nothing.
		expect(get(swUpdatePending)).toBe(false);
	});

	it('tamperGraceElapsed stays false through the grace window, then flips true', () => {
		vi.useFakeTimers();
		let value: boolean | undefined;
		const unsub = tamperGraceElapsed.subscribe((v) => {
			value = v;
		});
		// Within the grace window: banner stays suppressed so the snackbar leads.
		expect(value).toBe(false);
		vi.advanceTimersByTime(TAMPER_BANNER_GRACE_MS - 1);
		expect(value).toBe(false);
		// After the window: a persisting mismatch is now allowed to alarm.
		vi.advanceTimersByTime(2);
		expect(value).toBe(true);
		unsub();
	});

	it('grace window is a positive, bounded duration', () => {
		// A zero/negative window would defeat the fix (banner flashes instantly);
		// an unbounded one would hide genuine tamper forever.
		expect(TAMPER_BANNER_GRACE_MS).toBeGreaterThan(0);
		expect(TAMPER_BANNER_GRACE_MS).toBeLessThanOrEqual(30_000);
	});
});
