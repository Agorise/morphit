/**
 * The install's reachability safety net is a script root runs from a transient
 * timer. It must live where only root can change
 * it, and the timer must not be scheduled when what it would run is no longer
 * root's alone.
 *
 * Real module, real files; `systemd-run` and `systemctl` are stand-ins on PATH
 * that record their arguments. Runs only as root (it chowns files).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = mkdtempSync(join(tmpdir(), 'morphit-revert-'));
const BIN = join(S, 'bin');
const LOG = join(S, 'calls.log');
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const NOBODY = 65534;

const mod = await import('../src/init/reachabilityRevert.ts');

beforeAll(() => {
	mkdirSync(BIN);
	for (const cmd of ['systemd-run', 'systemctl']) {
		writeFileSync(join(BIN, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${LOG}"\nexit 0\n`, {
			mode: 0o755
		});
	}
	process.env.PATH = `${BIN}:${process.env.PATH}`;
});
afterAll(() => rmSync(S, { recursive: true, force: true }));
beforeEach(() => {
	rmSync(LOG, { force: true });
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

const scheduled = (): string[] =>
	existsSync(LOG)
		? readFileSync(LOG, 'utf8')
				.split('\n')
				.filter((l) => l.startsWith('systemd-run --on-active'))
		: [];

/** Arm into a fresh root-only parent; the directory the module actually used. */
function arm(): { handle: Awaited<ReturnType<typeof mod.armReachabilityRevert>>; dir: string } {
	const parent = mkdtempSync(join(S, 'root-'));
	const want = join(parent, 'reachability-revert');
	const arm = mod.armReachabilityRevert as (o?: { dir?: string }) => {
		armed: boolean;
		dir?: string;
	};
	const handle = arm({ dir: want });
	const dir = handle.dir ?? '/var/lib/morphit/reachability-revert';
	return { handle, dir };
}

describe.skipIf(!asRoot)('reachability revert: what root runs stays root’s', () => {
	it('the default place is not under the service user’s /var/lib/morphit', () => {
		expect(
			(mod as { REVERT_DIR?: string }).REVERT_DIR ?? '/var/lib/morphit/reachability-revert'
		).not.toMatch(/^\/var\/lib\/morphit\//);
	});

	it('an untouched snapshot is scheduled', async () => {
		const { handle, dir } = arm();
		expect(handle.armed).toBe(true);
		await mod.confirmReachabilityOrRevert(handle, 1);
		expect(scheduled()).toHaveLength(1);
		expect(scheduled()[0]).toContain(`${dir}/revert.sh`);
	});

	it('a revert directory handed to another user is not scheduled', async () => {
		const { handle, dir } = arm();
		chownSync(dir, NOBODY, NOBODY);
		await mod.confirmReachabilityOrRevert(handle, 1);
		expect(scheduled(), 'root scheduled a script another user can replace').toEqual([]);
	});

	it('a revert script another user can edit is not scheduled', async () => {
		const { handle, dir } = arm();
		chmodSync(join(dir, 'revert.sh'), 0o777);
		await mod.confirmReachabilityOrRevert(handle, 1);
		expect(scheduled(), 'root scheduled a world-writable script').toEqual([]);
	});

	it('a revert script swapped for a symlink is not scheduled', async () => {
		const { handle, dir } = arm();
		const elsewhere = join(S, `evil-${Math.random()}.sh`);
		writeFileSync(elsewhere, '#!/bin/bash\ntouch /tmp/pwned\n', { mode: 0o700 });
		rmSync(join(dir, 'revert.sh'));
		symlinkSync(elsewhere, join(dir, 'revert.sh'));
		await mod.confirmReachabilityOrRevert(handle, 1);
		expect(scheduled(), 'root scheduled a symlinked script').toEqual([]);
	});
});
