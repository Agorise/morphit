/**
 * Root's writes and reads in a directory another account owns never go
 * through a link that account planted (review G1, a regression of review B5).
 * Real files, real links, in a temporary directory.
 */
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshFileNoFollow, readNoFollow, writeNoFollow } from '../src/lib/noFollowFs.ts';

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'nofollow-'));
	const victim = join(dir, 'victim');
	writeFileSync(victim, 'SECRET\n');
	return { dir, victim };
}

describe('no-follow file access', () => {
	it('writeNoFollow refuses a planted link; the target is untouched', () => {
		const { dir, victim } = setup();
		const p = join(dir, 'state.json');
		symlinkSync(victim, p);
		expect(() => writeNoFollow(p, 'x')).toThrow();
		expect(readFileSync(victim, 'utf8')).toBe('SECRET\n');
	});
	it('readNoFollow never reads through a link', () => {
		const { dir, victim } = setup();
		const p = join(dir, 'state.json');
		symlinkSync(victim, p);
		expect(readNoFollow(p)).toBeNull();
	});
	it('freshFileNoFollow replaces a planted link with a new regular file', () => {
		const { dir, victim } = setup();
		const p = join(dir, 'heal.log');
		symlinkSync(victim, p);
		freshFileNoFollow(p, 'started\n');
		expect(lstatSync(p).isSymbolicLink()).toBe(false);
		expect(readFileSync(p, 'utf8')).toBe('started\n');
		expect(readFileSync(victim, 'utf8')).toBe('SECRET\n');
	});
	it('a planted FIFO cannot stall the writer', () => {
		const { dir } = setup();
		const p = join(dir, 'fifo');
		try {
			execFileSync('mkfifo', [p]);
		} catch {
			return; // no mkfifo here
		}
		expect(() => writeNoFollow(p, 'x')).toThrow();
		freshFileNoFollow(p, 'ok\n');
		expect(readFileSync(p, 'utf8')).toBe('ok\n');
	});
});
