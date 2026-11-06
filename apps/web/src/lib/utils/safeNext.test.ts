/**
 * safeNext — the `?next=` check /login and the import flow share (v1.23.0).
 */
import { describe, expect, it } from 'vitest';

import { safeNextPath, withNext } from './safeNext';

const O = 'https://morphit.io';

describe('safeNextPath', () => {
	it('keeps a same-origin path with its query and hash', () => {
		expect(safeNextPath('/en/witnesses', O)).toBe('/en/witnesses');
		expect(safeNextPath('/en/witnesses?x=1#y', O)).toBe('/en/witnesses?x=1#y');
		expect(safeNextPath('https://morphit.io/en/chat', O)).toBe('/en/chat');
	});

	it('refuses anything that leaves the origin', () => {
		for (const bad of [
			'/.//evil.example/x',
			'/en/..//evil.example',
			'/en/../\\evil.example',
			'//evil.example/x',
			'/\\evil.example',
			'https://evil.example/',
			'javascript:alert(1)',
			'http://morphit.io/en'
		]) {
			expect(safeNextPath(bad, O)).toBeNull();
		}
	});

	it('nothing given → null', () => {
		expect(safeNextPath(null, O)).toBeNull();
		expect(safeNextPath('', O)).toBeNull();
		expect(safeNextPath(undefined, O)).toBeNull();
	});
});

describe('withNext', () => {
	it('carries a checked next along, encoded', () => {
		expect(withNext('/onboarding/import', '/en/witnesses', O)).toBe(
			'/onboarding/import?next=%2Fen%2Fwitnesses'
		);
		expect(withNext('/a?b=1', '/en/witnesses', O)).toBe('/a?b=1&next=%2Fen%2Fwitnesses');
	});

	it('drops a next that would leave the origin', () => {
		expect(withNext('/onboarding/import', '//evil.example', O)).toBe('/onboarding/import');
		expect(withNext('/onboarding/import', null, O)).toBe('/onboarding/import');
	});
});
