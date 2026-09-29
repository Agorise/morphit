/**
 * Root writes the upgrade makes into directories a non-root account owns must
 * never follow a link planted there (review B5).
 *
 * /var/lib/morphit is the morphit service user's home (the base role chowns it
 * recursively), and apps/web/build is handed to the warrant-canary uploader
 * before verify.json is stamped. A plain writeFileSync as root followed a link
 * at either place and overwrote whatever it pointed at.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	existsSync,
	lstatSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordCanarySeen, patchVerifyJsonOperatorTag } from '../src/commands/upgrade.ts';

let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('upgrade writes into non-root-owned dirs do not follow links', () => {
	it('recordCanarySeen leaves a link target untouched', () => {
		root = mkdtempSync(join(tmpdir(), 'morphit-nofollow-'));
		const victim = join(root, 'victim');
		writeFileSync(victim, 'root-only config\n');
		const marker = join(root, 'home', 'canary-seen');
		recordCanarySeen(join(root, 'home', 'warmup')); // creates the dir
		symlinkSync(victim, marker);
		recordCanarySeen(marker);
		expect(readFileSync(victim, 'utf8')).toBe('root-only config\n');
	});

	it('recordCanarySeen still records on a normal path', () => {
		root = mkdtempSync(join(tmpdir(), 'morphit-nofollow-'));
		const marker = join(root, 'home', 'canary-seen');
		recordCanarySeen(marker);
		expect(existsSync(marker) && lstatSync(marker).isFile()).toBe(true);
		expect(readFileSync(marker, 'utf8')).toMatch(/^seen /);
	});

	it('patchVerifyJsonOperatorTag does not write through a verify.json link', () => {
		root = mkdtempSync(join(tmpdir(), 'morphit-nofollow-'));
		const victim = join(root, 'victim.json');
		const original = '{"operator_tag": null, "keep": "me"}\n';
		writeFileSync(victim, original);
		const build = join(root, 'build');
		recordCanarySeen(join(build, 'x')); // mkdir build
		symlinkSync(victim, join(build, 'verify.json'));
		patchVerifyJsonOperatorTag(build, 'evil');
		expect(readFileSync(victim, 'utf8')).toBe(original);
	});

	it('patchVerifyJsonOperatorTag stamps a real verify.json', () => {
		root = mkdtempSync(join(tmpdir(), 'morphit-nofollow-'));
		const build = join(root, 'build');
		recordCanarySeen(join(build, 'x'));
		writeFileSync(join(build, 'verify.json'), '{"operator_tag": null}\n');
		expect(patchVerifyJsonOperatorTag(build, 'my.node')).toBe(true);
		expect(JSON.parse(readFileSync(join(build, 'verify.json'), 'utf8')).operator_tag).toBe(
			'my.node'
		);
	});
});
