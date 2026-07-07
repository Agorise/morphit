import { describe, it, expect } from 'vitest';

import {
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
