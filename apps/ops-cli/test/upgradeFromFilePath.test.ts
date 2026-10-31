/**
 * `upgrade --from-file=<path>` reads the path the way the operator typed it
 * (morphitlat, 2026-10-30). The installed launcher runs the CLI from
 * /opt/morphit/apps/ops-cli, so a relative path was looked up there; and the
 * shell leaves a `~` right after `=` as it is, so `--from-file=~/Downloads/…`
 * became /opt/morphit/apps/ops-cli/~/Downloads/….
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveOfflineTarball } from '../src/commands/upgrade.ts';

const NAME = 'morphit-v1.21.18-offline.tar.gz';

function home(): { home: string; downloads: string; bundle: string } {
	const h = mkdtempSync(join(tmpdir(), 'from-file-home-'));
	const downloads = join(h, 'Downloads');
	mkdirSync(downloads);
	const bundle = join(downloads, NAME);
	writeFileSync(bundle, 'x');
	writeFileSync(`${bundle}.asc`, 'sig');
	return { home: h, downloads, bundle };
}

/** As the launcher runs it: from inside the install, the caller's folder passed along. */
const INSTALL_CLI = '/opt/morphit/apps/ops-cli';

describe('upgrade --from-file: the path as the operator typed it', () => {
	it('"~/Downloads/…" is the home of the person who ran the command', () => {
		const { home: h, bundle } = home();
		const env = { HOME: h, MORPHIT_OPS_CALLER_CWD: '/somewhere/else' };
		const r = resolveOfflineTarball({ 'from-file': `~/Downloads/${NAME}` }, env, INSTALL_CLI);
		expect(r?.tarballPath).toBe(bundle);
		expect(r?.sigPath).toBe(`${bundle}.asc`);
		expect(r?.tag).toBe('v1.21.18');
	});

	it('a relative path is read from the folder the command was typed in', () => {
		const { downloads, bundle } = home();
		const env = { MORPHIT_OPS_CALLER_CWD: downloads };
		const r = resolveOfflineTarball({ 'from-file': NAME }, env, INSTALL_CLI);
		expect(r?.tarballPath).toBe(bundle);
	});

	it('an absolute path is kept as it is', () => {
		const { bundle } = home();
		const r = resolveOfflineTarball(
			{ 'from-file': bundle },
			{ MORPHIT_OPS_CALLER_CWD: '/x' },
			INSTALL_CLI
		);
		expect(r?.tarballPath).toBe(bundle);
	});

	it('a missing file still names where it looked', () => {
		const { downloads } = home();
		expect(() =>
			resolveOfflineTarball(
				{ 'from-file': 'nope-v1.21.18-offline.tar.gz' },
				{ MORPHIT_OPS_CALLER_CWD: downloads },
				INSTALL_CLI
			)
		).toThrow(`--from-file: no such file: ${join(downloads, 'nope-v1.21.18-offline.tar.gz')}`);
	});
});
