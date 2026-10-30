import { describe, it, expect, vi } from 'vitest';

import {
	createDeployedVersionPoll,
	parseDeployedVersion,
	deployedVersionDiffers,
	verifyJsonPollUrl,
	VERIFY_JSON_PATH
} from './deployedVersion';

describe('deployedVersion — parseDeployedVersion', () => {
	it('extracts morphit_version from a well-formed verify.json body', () => {
		expect(parseDeployedVersion('{"morphit_version":"1.0.0-beta.23"}')).toBe('1.0.0-beta.23');
	});

	it('tolerates extra fields (the real verify.json carries a hash manifest)', () => {
		const body = JSON.stringify({
			morphit_version: '1.0.0-beta.22',
			commit: 'abc',
			operator: null,
			files: { 'a.js': 'deadbeef' }
		});
		expect(parseDeployedVersion(body)).toBe('1.0.0-beta.22');
	});

	it('trims surrounding whitespace', () => {
		expect(parseDeployedVersion('{"morphit_version":"  1.0.0-beta.23  "}')).toBe('1.0.0-beta.23');
	});

	it('returns null when the field is missing', () => {
		expect(parseDeployedVersion('{"version":"1.0.0-beta.23"}')).toBeNull();
	});

	it('returns null when the field is not a string', () => {
		expect(parseDeployedVersion('{"morphit_version":23}')).toBeNull();
		expect(parseDeployedVersion('{"morphit_version":null}')).toBeNull();
	});

	it('returns null for an empty / whitespace version', () => {
		expect(parseDeployedVersion('{"morphit_version":""}')).toBeNull();
		expect(parseDeployedVersion('{"morphit_version":"   "}')).toBeNull();
	});

	it('returns null for unparseable bodies (e.g. a gated HTML 401 page)', () => {
		expect(parseDeployedVersion('<!doctype html><title>401 Unauthorized</title>')).toBeNull();
		expect(parseDeployedVersion('')).toBeNull();
		expect(parseDeployedVersion('not json')).toBeNull();
	});
});

describe('deployedVersion — deployedVersionDiffers', () => {
	it('false when the deployed version is unknown (null)', () => {
		// fetch failed / gated / unparseable → never nag without evidence
		expect(deployedVersionDiffers(null, '1.0.0-beta.22')).toBe(false);
	});

	it('false when the running version is the empty/sentinel value', () => {
		expect(deployedVersionDiffers('1.0.0-beta.23', '')).toBe(false);
	});

	it('false when deployed equals running (already up to date)', () => {
		expect(deployedVersionDiffers('1.0.0-beta.22', '1.0.0-beta.22')).toBe(false);
	});

	it('true when deployed differs from running (a newer deploy)', () => {
		expect(deployedVersionDiffers('1.0.0-beta.23', '1.0.0-beta.22')).toBe(true);
	});

	it('true for a rollback too (any difference = the served bundle is not ours)', () => {
		expect(deployedVersionDiffers('1.0.0-beta.9', '1.0.0-beta.22')).toBe(true);
	});
});

describe('deployedVersion — verifyJsonPollUrl', () => {
	it('targets /verify.json with a cache-buster query', () => {
		const url = verifyJsonPollUrl(1234567890);
		expect(url).toBe('/verify.json?cb=1234567890');
		expect(url.startsWith(VERIFY_JSON_PATH)).toBe(true);
		expect(url).toContain('?cb=');
	});

	it('produces a distinct URL per call (defeats a proxy edge cache)', () => {
		expect(verifyJsonPollUrl(1)).not.toBe(verifyJsonPollUrl(2));
	});
});

describe('deployedVersion — one poll at a time (v1.21.18 review)', () => {
	// Over Tor a read takes up to its 45 s budget, longer than the 30 s between
	// polls: the second poll must join the first, not start a second download.
	it('a poll while a slow read is still running joins it; the next starts after it ends', async () => {
		vi.useFakeTimers();
		try {
			let reads = 0;
			const seen: string[] = [];
			const poll = createDeployedVersionPoll({
				read: () => {
					reads++;
					return new Promise((r) => setTimeout(() => r(`1.0.${reads}`), 45_000));
				},
				onVersion: (v) => void seen.push(v),
				now: () => Date.now(),
				minGapMs: 10_000
			});
			const timer = setInterval(() => void poll(), 30_000);
			void poll(); // t = 0: the first read starts
			await vi.advanceTimersByTimeAsync(30_000); // t = 30 s: the interval polls; read 1 still running
			expect(reads).toBe(1);
			void poll(); // the tab comes back into view meanwhile
			expect(reads).toBe(1);
			await vi.advanceTimersByTimeAsync(15_000); // t = 45 s: read 1 ends
			expect(seen).toEqual(['1.0.1']);
			await vi.advanceTimersByTimeAsync(15_000); // t = 60 s: the next poll starts a new read
			expect(reads).toBe(2);
			await vi.advanceTimersByTimeAsync(45_000);
			expect(seen).toEqual(['1.0.1', '1.0.2']);
			clearInterval(timer);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a reader that throws at once does not leave the poll stuck', async () => {
		let reads = 0;
		let t = 0;
		const poll = createDeployedVersionPoll({
			read: () => {
				reads++;
				throw new Error('boom');
			},
			onVersion: () => {},
			now: () => t,
			minGapMs: 10_000
		});
		await poll();
		t = 20_000;
		await poll();
		expect(reads).toBe(2);
	});

	it('nothing is asked once the page is gone', async () => {
		let reads = 0;
		const poll = createDeployedVersionPoll({
			read: async () => (reads++, '1.0.0'),
			onVersion: () => {},
			now: () => 0,
			minGapMs: 0,
			cancelled: () => true
		});
		await poll();
		expect(reads).toBe(0);
	});
});
