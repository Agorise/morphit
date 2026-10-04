/**
 * The /etc/morphit permission heal, run for real on a temp directory (as
 * root, with the `daemon` group standing in for `morphit`), and its refusal
 * to act through a link.
 */
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { healEtcMorphitPerms } from '../src/lib/etcPermHeal.ts';

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
const root = typeof process.getuid === 'function' && process.getuid() === 0;
const gidOf = (g: string): number =>
	Number((spawnSync('getent', ['group', g], { encoding: 'utf8' }).stdout ?? '').split(':')[2]);

describe.skipIf(!root)('/etc/morphit goes back to root:morphit 0750', () => {
	it('root:root 0755 (what the ipfs role left) → root:<group> 0750, read back; then nothing to do', async () => {
		const d = mkdtempSync(join(tmpdir(), 'etcperm-'));
		const p = join(d, 'morphit');
		mkdirSync(p);
		chownSync(p, 0, 0);
		chmodSync(p, 0o755);
		const out = await healEtcMorphitPerms(ctx, { path: p, group: 'daemon' });
		expect(out).toMatchObject({ strategy: 'fixed', verified: true });
		const st = statSync(p);
		expect([st.uid, st.gid, st.mode & 0o777]).toEqual([0, gidOf('daemon'), 0o750]);
		expect((await healEtcMorphitPerms(ctx, { path: p, group: 'daemon' })).strategy).toBe('already');
		rmSync(d, { recursive: true, force: true });
	});

	it('a link is never followed; a missing group or directory is left alone', async () => {
		const d = mkdtempSync(join(tmpdir(), 'etcperm-'));
		const target = join(d, 'elsewhere');
		mkdirSync(target);
		chmodSync(target, 0o755);
		symlinkSync(target, join(d, 'morphit'));
		const out = await healEtcMorphitPerms(ctx, { path: join(d, 'morphit'), group: 'daemon' });
		expect(out.verified).toBe(false);
		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(
			(await healEtcMorphitPerms(ctx, { path: join(d, 'nope'), group: 'daemon' })).strategy
		).toBe('skipped');
		expect(
			(await healEtcMorphitPerms(ctx, { path: target, group: 'no-such-group-xyz' })).strategy
		).toBe('skipped');
		rmSync(d, { recursive: true, force: true });
	});
});
