/**
 * /etc/morphit/relay-notify.env holds passwords: the temp file it is written
 * through must be unreadable to others FROM THE MOMENT IT EXISTS — not only
 * after a chmod a moment later (review E4) — and a save that fails leaves the
 * old file as it was and no temp file behind.
 *
 * `openSync` is wrapped to look at each file the moment it is created (its
 * mode, read from the open descriptor), with the umask cleared so the mode is
 * the one the code asked for; `renameSync` can be made to fail.
 */
import {
	chownSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seen: Array<{ path: string; mode: number }> = [];
let failRename = false;

vi.mock('node:fs', async (importOriginal) => {
	const fs = await importOriginal<typeof import('node:fs')>();
	const openSync = ((path: string, flags: number | string, mode?: number) => {
		const fd = fs.openSync(path, flags, mode);
		if (String(path).includes('.relay-notify.env.'))
			seen.push({ path: String(path), mode: fs.fstatSync(fd).mode & 0o777 });
		return fd;
	}) as typeof fs.openSync;
	const renameSync = ((a: string, b: string) => {
		if (failRename) throw Object.assign(new Error('EIO: rename failed'), { code: 'EIO' });
		fs.renameSync(a, b);
	}) as typeof fs.renameSync;
	return { ...fs, default: { ...fs, openSync, renameSync }, openSync, renameSync };
});

const { writeNotifyEnv } = await import('../src/lib/offlineNotifyEnv.ts');

const dirs: string[] = [];
afterEach(() => {
	seen.length = 0;
	failRename = false;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('relay-notify.env temp file', () => {
	it('is created readable by root alone (0600), whatever the umask', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notify-tmp-'));
		dirs.push(dir);
		const old = process.umask(0);
		try {
			writeNotifyEnv(
				{ MORPHIT_NOTIFY_EMAIL_PASSWORD: 's3cret' },
				join(dir, 'relay-notify.env'),
				'daemon'
			);
		} finally {
			process.umask(old);
		}
		expect(seen).toHaveLength(1);
		expect(seen[0]!.path.startsWith(join(dir, '.relay-notify.env.'))).toBe(true);
		expect(seen[0]!.mode).toBe(0o600);
	});

	it('a save that fails leaves the old file as it was and no temp file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notify-tmp-'));
		dirs.push(dir);
		const file = join(dir, 'relay-notify.env');
		writeNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: 'old' }, file, 'daemon');
		const before = readFileSync(file, 'utf8');
		failRename = true;
		expect(() => writeNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: 'new' }, file, 'daemon')).toThrow(
			/rename failed/
		);
		expect(readFileSync(file, 'utf8')).toBe(before);
		expect(readdirSync(dir)).toEqual(['relay-notify.env']);
	});
});

describe('relay-notify.env owner', () => {
	const gidOf = (name: string): number =>
		Number(String(spawnSync('getent', ['group', name], { encoding: 'utf8' }).stdout).split(':')[2]);

	// Ownership can only be given away by root (the tool runs under sudo).
	it.skipIf(process.getuid?.() !== 0)(
		'is root and the relay group, 0640 — a group root is not in, whoever owned the old file',
		() => {
			const dir = mkdtempSync(join(tmpdir(), 'notify-own-'));
			dirs.push(dir);
			const file = join(dir, 'relay-notify.env');
			const group = 'daemon';
			const gid = gidOf(group);
			expect(gid).toBeGreaterThan(0);
			// An old file a hand edit left owned by someone else (bin:bin).
			writeFileSync(file, 'MORPHIT_NOTIFY_EMAIL_HOST=old\n', { mode: 0o644 });
			chownSync(file, 2, 2);
			writeNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: 's3cret' }, file, group);
			const st = statSync(file);
			expect({ uid: st.uid, gid: st.gid, mode: st.mode & 0o777 }).toEqual({
				uid: 0,
				gid,
				mode: 0o640
			});
		}
	);
});
