/**
 * The guided install offers fast-sync.
 *
 * Only the "Configure only" path offered to restore the federation snapshot;
 * the full guided install never asked, so a fresh VPS started replaying the
 * whole chain from genesis — 4.8 million blocks behind (2026-10-12).
 *
 * Review of v1.21.18, 2026-10-29: its restore stopped only the indexer, while
 * the relay went on writing to the same database being replaced. It now stops
 * both, the way `fast-sync` does, and starts the relay only once the indexer
 * answers. `systemctl` is a stand-in on PATH that logs what it is asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { offerFastSync, restoreDuringInstall } from '../src/init/runAnsibleInstall.ts';

function run(o: { yes: boolean; syncRc?: number; reinstall?: boolean; online?: boolean }) {
	const order: string[] = [];
	const out: string[] = [];
	const defaults: boolean[] = [];
	return offerFastSync({
		reinstall: o.reinstall ?? false,
		online: o.online ?? true,
		askYesNo: async (_q, def) => (defaults.push(def), o.yes),
		restore: () => {
			order.push('restore');
			return o.syncRc ?? 0;
		},
		print: (s) => void out.push(s)
	}).then((r) => ({ r, order, out: out.join('\n'), defaults }));
}

describe('fast-sync during the guided install', () => {
	it('yes: restores the snapshot', async () => {
		const { r, order } = await run({ yes: true });
		expect(order).toEqual(['restore']);
		expect(r).toBe('synced');
	});

	it('a restore that did not go through: said, with how to retry', async () => {
		const { r, out } = await run({ yes: true, syncRc: 1 });
		expect(r).toBe('failed');
		expect(out).toContain('sudo morphit-ops fast-sync');
	});

	it('a replaced database that must not be served: reported as such', async () => {
		expect((await run({ yes: true, syncRc: 4 })).r).toBe('unusable');
	});

	it('a fresh install is offered it with yes as the default', async () => {
		const { defaults } = await run({ yes: true });
		expect(defaults).toEqual([true]);
	});

	it('a re-install over an existing node defaults to no: its own data would be replaced', async () => {
		// Its own pending payouts, push subscriptions and moderation live in the
		// same database, and a restore replaces it.
		const { defaults } = await run({ yes: false, reinstall: true });
		expect(defaults).toEqual([false]);
	});

	it('offline: not offered (it could only fail), says how to do it later', async () => {
		const { r, order, defaults, out } = await run({ yes: true, online: false });
		expect(defaults).toEqual([]);
		expect(order).toEqual([]);
		expect(r).toBe('skipped');
		expect(out).toContain('sudo morphit-ops fast-sync');
	});

	it('no: touches nothing, and says how to do it later', async () => {
		const { r, order, out } = await run({ yes: false });
		expect(order).toEqual([]);
		expect(r).toBe('skipped');
		expect(out).toContain('sudo morphit-ops fast-sync');
	});
});

describe('the install’s restore stops and starts what shares the database', () => {
	let dir = '';
	const PATH = process.env.PATH;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'install-fastsync-'));
		writeFileSync(join(dir, 'log'), '');
		writeFileSync(
			join(dir, 'systemctl'),
			[
				'#!/bin/sh',
				`D=${dir}`,
				'echo "$@" >> "$D/log"',
				'case "$1" in',
				'  is-active) if [ -f "$D/stopped-$2" ]; then echo inactive; else echo active; fi ;;',
				'  stop) touch "$D/stopped-$2" ;;',
				'  start) rm -f "$D/stopped-$2" ;;',
				'esac',
				''
			].join('\n'),
			{ mode: 0o755 }
		);
		process.env.PATH = `${dir}:${PATH}`;
		vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	});
	afterEach(() => {
		process.env.PATH = PATH;
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});
	const units = (): string[] =>
		readFileSync(join(dir, 'log'), 'utf8')
			.split('\n')
			.filter((l) => /^(stop|start) /.test(l));

	it('the relay is stopped before the restore, and started after the indexer answers', async () => {
		const during: string[][] = [];
		const rc = await restoreDuringInstall({
			fastSync: () => {
				during.push(units());
				return 0;
			},
			indexerAnswers: async () => {
				during.push(units());
				return true;
			}
		});
		expect(rc).toBe(0);
		// Both were stopped before the restore ran…
		expect(during[0]).toEqual(['stop morphit-relay', 'stop morphit-indexer']);
		// …and the relay was not started before the indexer answered.
		expect(during[1]).not.toContain('start morphit-relay');
		expect(units()).toEqual([
			'stop morphit-relay',
			'stop morphit-indexer',
			'start morphit-indexer',
			'start morphit-relay'
		]);
	});

	it('an indexer that does not answer after a restore: the relay is left stopped', async () => {
		const rc = await restoreDuringInstall({ fastSync: () => 0, indexerAnswers: async () => false });
		expect(rc).toBe(0);
		expect(units()).toEqual([
			'stop morphit-relay',
			'stop morphit-indexer',
			'start morphit-indexer'
		]);
	});

	it('a restore that did not go through: both are started again', async () => {
		await restoreDuringInstall({ fastSync: () => 1, indexerAnswers: async () => false });
		expect(units()).toEqual([
			'stop morphit-relay',
			'stop morphit-indexer',
			'start morphit-indexer',
			'start morphit-relay'
		]);
	});

	it('exit 4 (replaced, not to be served): both are left stopped', async () => {
		await restoreDuringInstall({ fastSync: () => 4, indexerAnswers: async () => true });
		expect(units()).toEqual(['stop morphit-relay', 'stop morphit-indexer']);
	});
});
