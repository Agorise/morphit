// @vitest-environment jsdom
/**
 * v1.20.0 review (F-7): the idle auto-lock must follow the Settings choice
 * WHILE the session is running. [lang]/+layout.svelte starts the timer once
 * when the session unlocks (its $effect depends only on $isUnlocked), so a
 * timer that read the timeout once kept the old value: picking "15 minutes"
 * did nothing until the next unlock, and picking "Never" still locked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAutoLockTimer, writeTimeoutMinutes, NEVER_LOCK } from './autoLock';

const MIN = 60_000;

describe('auto-lock timer follows the timeout setting live', () => {
	let stop: () => void = () => undefined;
	beforeEach(() => {
		vi.useFakeTimers();
		window.localStorage.clear();
		writeTimeoutMinutes(540); // the 9 h default
	});
	afterEach(() => {
		stop();
		vi.useRealTimers();
	});

	it('shortening the timeout while unlocked applies without a re-unlock', () => {
		let fired = 0;
		stop = startAutoLockTimer(() => fired++);
		writeTimeoutMinutes(15); // Settings → Session → 15 minutes
		vi.advanceTimersByTime(15 * MIN + 1);
		expect(fired).toBe(1);
	});

	it('choosing "Never" while unlocked cancels the running timer', () => {
		let fired = 0;
		writeTimeoutMinutes(15);
		stop = startAutoLockTimer(() => fired++);
		writeTimeoutMinutes(NEVER_LOCK);
		vi.advanceTimersByTime(24 * 60 * MIN);
		expect(fired).toBe(0);
	});

	it('turning auto-lock back on from "Never" starts a timer', () => {
		let fired = 0;
		writeTimeoutMinutes(NEVER_LOCK);
		stop = startAutoLockTimer(() => fired++);
		writeTimeoutMinutes(30);
		vi.advanceTimersByTime(30 * MIN + 1);
		expect(fired).toBe(1);
	});

	it('activity still pushes the lock back, and stop() tears everything down', () => {
		let fired = 0;
		writeTimeoutMinutes(15);
		stop = startAutoLockTimer(() => fired++);
		vi.advanceTimersByTime(10 * MIN);
		document.dispatchEvent(new Event('keydown'));
		vi.advanceTimersByTime(10 * MIN);
		expect(fired).toBe(0);
		stop();
		writeTimeoutMinutes(15); // a later change must not re-arm a stopped timer
		vi.advanceTimersByTime(60 * MIN);
		expect(fired).toBe(0);
	});
});
