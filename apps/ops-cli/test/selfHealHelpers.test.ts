/**
 * Wave 4 (P7): the helper-script refresh must run in the post-upgrade SELF-HEAL
 * phase — the only part of `morphit-ops upgrade` executed by the NEW binary on
 * the upgrade that ships it. In the old orchestrator's flow it would reach the
 * live boxes only one upgrade later (so C3's root-exec hole in
 * morphit-first-online.sh and C17's ipfs-pin stall would survive this upgrade).
 * Drives the real self-heal step against scratch dirs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selfHealSteps } from '../src/commands/upgrade.ts';

let root = '';
const saved = { ...process.env };
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-selfheal-helpers-'));
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

describe('self-heal phase refreshes /usr/local/lib/morphit helpers', () => {
	it('has a helper-script refresh step, early (right after the relay heal)', () => {
		const names = selfHealSteps().map(([n]) => n);
		expect(names).toContain('the helper-script refresh');
		expect(names.indexOf('the helper-script refresh')).toBe(1);
	});

	it('that step replaces an outdated installed helper from the NEW release (with .bak)', async () => {
		const release = join(root, 'opt-morphit');
		mkdirSync(join(release, 'ops', 'ipfs'), { recursive: true });
		writeFileSync(join(release, 'ops', 'ipfs', 'morphit-ipfs-pin.sh'), '#!/bin/sh\necho fixed\n');
		const helpers = join(root, 'usr-local-lib-morphit');
		mkdirSync(helpers);
		writeFileSync(join(helpers, 'morphit-ipfs-pin.sh'), '#!/bin/sh\necho stall 900\n');
		chmodSync(join(helpers, 'morphit-ipfs-pin.sh'), 0o755);
		process.env.MORPHIT_INSTALL_DIR = release;
		process.env.MORPHIT_HELPER_DIR = helpers;
		const step = selfHealSteps().find(([n]) => n === 'the helper-script refresh')!;
		await step[1]();
		expect(readFileSync(join(helpers, 'morphit-ipfs-pin.sh'), 'utf8')).toBe(
			'#!/bin/sh\necho fixed\n'
		);
		expect(readFileSync(join(helpers, 'morphit-ipfs-pin.sh.bak'), 'utf8')).toBe(
			'#!/bin/sh\necho stall 900\n'
		);
	});

	it('v1.20.0: the IPFS clean-up and the tor-only OS heal run their REAL entry points (tor-only early)', async () => {
		const names = selfHealSteps().map(([n]) => n);
		// Wave 2 (O1): the tor-only heal runs early (right after the helper refresh,
		// which installs its script), before the IPFS clean-up and the slow network
		// heals; the fees-account heal stays last.
		expect(names.indexOf('the tor-only OS heal')).toBe(
			names.indexOf('the helper-script refresh') + 1
		);
		expect(names.indexOf('the tor-only OS heal')).toBeLessThan(names.indexOf('the IPFS clean-up'));
		expect(names.indexOf('the tor-only OS heal')).toBeLessThan(
			names.indexOf('the web-proxy heals')
		);
		// v1.20.1: the background web heal's result is shown last, right after the
		// fees-account heal (which needs its time before the child's kill).
		expect(names[names.length - 1]).toBe('the web-proxy result');
		expect(names.indexOf('the fees-account registration heal')).toBeLessThan(
			names.indexOf('the web-proxy result')
		);
		expect(names.indexOf('the web-proxy heals')).toBeLessThan(
			names.indexOf('the web-proxy result')
		);
		// No Kubo here: the real clean-up heal says so and touches nothing.
		process.env.IPFS_PATH = join(root, 'no-ipfs-here');
		const gc = selfHealSteps().find(([n]) => n === 'the IPFS clean-up')!;
		expect(await gc[1]()).toEqual({ kind: 'no-kubo' });
		// Not a hidden-only node (no indexer.env with an empty clearnet pool).
		process.env.MORPHIT_ENV_ROOT = root;
		const tor = selfHealSteps().find(([n]) => n === 'the tor-only OS heal')!;
		expect(await tor[1]()).toEqual({
			apt: 'not-tor-only',
			time: 'not-tor-only',
			news: 'not-tor-only'
		});
	});
});
