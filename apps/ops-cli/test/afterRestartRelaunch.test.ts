/**
 * A second upgrade while the first one's background checks
 * (morphit-after-upgrade-heal) still run: those run the EARLIER release's
 * code. Treating "already running" as "launched" meant this release's
 * after-restart checks never ran, without a word. Now the earlier run is
 * stopped and this release's started; when it cannot be stopped, the upgrade
 * says plainly that this release's checks did not run, and how to run them.
 *
 * Driven against the real code with a recording `systemctl` / `systemd-run`
 * on PATH.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OPS = resolve(HERE, '..');
const TSX = resolve(OPS, '../../node_modules/.bin/tsx');
const UPGRADE = join(OPS, 'src', 'commands', 'upgrade.ts');
const UNIT = 'morphit-after-upgrade-heal';

function run(opts: { active: boolean; stopWorks: boolean }) {
	const dir = mkdtempSync(join(tmpdir(), 'after-restart-relaunch-'));
	try {
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		const state = join(dir, 'active');
		const calls = join(dir, 'calls');
		writeFileSync(state, opts.active ? '1' : '0');
		writeFileSync(calls, '');
		// systemctl: is-active answers from the state file; stop clears it
		// (unless told it fails); everything is recorded.
		writeFileSync(
			join(bin, 'systemctl'),
			`#!/bin/sh
printf 'systemctl %s\\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in
	*is-active*${UNIT}*) [ "$(cat ${JSON.stringify(state)})" = 1 ] && exit 0; exit 3 ;;
	stop*${UNIT}*) ${opts.stopWorks ? `echo 0 > ${JSON.stringify(state)}; exit 0` : 'exit 1'} ;;
esac
exit 0
`
		);
		writeFileSync(
			join(bin, 'systemd-run'),
			`#!/bin/sh
printf 'systemd-run %s\\n' "$*" >> ${JSON.stringify(calls)}
echo 1 > ${JSON.stringify(state)}
exit 0
`
		);
		chmodSync(join(bin, 'systemctl'), 0o755);
		chmodSync(join(bin, 'systemd-run'), 0o755);
		const runner = join(dir, 'run.mts');
		writeFileSync(
			runner,
			`const up = await import(${JSON.stringify(UPGRADE)});\nawait up.startAfterRestartHeals();\nconsole.log('RETURNED');\nprocess.exit(0);\n`
		);
		const r = spawnSync(TSX, [runner], {
			encoding: 'utf8',
			timeout: 90_000,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				MORPHIT_AFTER_RESTART_LOG: join(dir, 'after.log'),
				MORPHIT_UPGRADE_SUMMARIZES: '',
				NO_COLOR: '1'
			}
		});
		return {
			out: `${r.stdout}\n${r.stderr}`,
			calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("a second upgrade while the earlier upgrade's background checks run", () => {
	it('stops the earlier run (older code) and starts this release’s', () => {
		const { out, calls } = run({ active: true, stopWorks: true });
		expect(out).toMatch(/RETURNED/);
		const stop = calls.findIndex((c) => c === `systemctl stop ${UNIT}`);
		const start = calls.findIndex((c) => c.startsWith(`systemd-run --unit=${UNIT}`));
		expect(stop, calls.join('\n')).toBeGreaterThanOrEqual(0);
		expect(start, calls.join('\n')).toBeGreaterThan(stop);
		expect(out).toMatch(/earlier upgrade/i);
	}, 120_000);

	it('when the earlier run cannot be stopped: says plainly that this release’s checks did not run, and how to run them', () => {
		const { out, calls } = run({ active: true, stopWorks: false });
		expect(calls.some((c) => c.startsWith('systemd-run'))).toBe(false);
		expect(out).toMatch(/did not run/);
		expect(out).toMatch(/sudo morphit-ops upgrade --heals/);
	}, 120_000);

	it('nothing running: started at once, nothing stopped', () => {
		const { calls } = run({ active: false, stopWorks: true });
		expect(calls.some((c) => c.startsWith('systemctl stop'))).toBe(false);
		expect(calls.filter((c) => c.startsWith(`systemd-run --unit=${UNIT}`)).length).toBe(1);
	}, 120_000);
});
