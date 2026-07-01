/**
 * status-backups-smoke (beta6)
 *
 * Guards the "Backups" section of `morphit-ops status` (#10 Status
 * dashboard).  The operator uses it to confirm the last few DB backups
 * actually ran, and to grab the on-disk path so they can download a
 * backup or hand it to a dev.  What must never regress:
 *
 *   1. resolveBackupDir() prefers the MORPHIT_BACKUP_DIR override, else
 *      BACKUP_DIR from /etc/morphit/backup.env, else the wizard default
 *      (/home/morphit/backups).
 *   2. collectBackups() returns the up-to-3 MOST RECENT backup files
 *      (morphit-YYYYMMDD-HHMMSS.sql.gz, plus the .age-encrypted variant)
 *      newest-first, ignores non-backup files, echoes the directory, and
 *      sets a note when there's nothing to show (no dir / none yet) —
 *      never throwing, never mutating the filesystem.
 *
 * Backups are filesystem state, so the function is exercised against a
 * real temp directory with controlled mtimes (no DB needed).
 */
import {
	mkdtempSync,
	writeFileSync,
	utimesSync,
	rmSync,
	readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBackups, resolveBackupDir } from '../src/commands/status.ts';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
	} else {
		failures.push(name);
		console.error(`  ✗ ${name}`);
	}
}

const ORIG = process.env.MORPHIT_BACKUP_DIR;
function setDir(d: string | undefined): void {
	if (d === undefined) delete process.env.MORPHIT_BACKUP_DIR;
	else process.env.MORPHIT_BACKUP_DIR = d;
}
function writeBackup(dir: string, name: string, sizeBytes: number, mtimeSec: number): void {
	writeFileSync(join(dir, name), Buffer.alloc(sizeBytes, 0x61));
	utimesSync(join(dir, name), mtimeSec, mtimeSec);
}

// ── 1. resolveBackupDir prefers the override ──
setDir('/tmp/some-explicit-backup-dir');
check('resolveBackupDir prefers MORPHIT_BACKUP_DIR', resolveBackupDir() === '/tmp/some-explicit-backup-dir');

// ── 2. resolveBackupDir falls back when unset ──
setDir(undefined);
{
	const d = resolveBackupDir();
	// In the sandbox there's no readable /etc/morphit/backup.env, so this is
	// the wizard default; on a real host it could be a BACKUP_DIR from there.
	check('resolveBackupDir fallback non-empty', typeof d === 'string' && d.length > 0);
}

// ── 3. directory missing ──
setDir(join(tmpdir(), `morphit-no-such-dir-${Date.now()}`));
{
	const b = collectBackups();
	check('missing dir → dir_exists false', b.dir_exists === false);
	check('missing dir → recent empty', b.recent.length === 0);
	check('missing dir → note set', b.note !== null);
	check('missing dir → dir echoed for the operator', b.dir === process.env.MORPHIT_BACKUP_DIR);
}

// ── 4. empty directory ──
const empty = mkdtempSync(join(tmpdir(), 'morphit-bk-empty-'));
setDir(empty);
{
	const b = collectBackups();
	check('empty dir → dir_exists true', b.dir_exists === true);
	check('empty dir → recent empty', b.recent.length === 0);
	check('empty dir → note "no backups found yet"', b.note === 'no backups found yet');
}
rmSync(empty, { recursive: true, force: true });

// ── 5–8. populated directory ──
const dir = mkdtempSync(join(tmpdir(), 'morphit-bk-'));
setDir(dir);
writeBackup(dir, 'morphit-20260601-040000.sql.gz', 100, 1000);
writeBackup(dir, 'morphit-20260602-040000.sql.gz', 200, 2000);
writeBackup(dir, 'morphit-20260603-040000.sql.gz.age', 300, 3000); // .age variant
writeBackup(dir, 'morphit-20260604-040000.sql.gz', 400, 4000); // newest
writeFileSync(join(dir, 'notes.txt'), 'junk'); // non-backup
writeFileSync(join(dir, 'morphit-bad.sql.gz'), 'wrong stamp'); // does not match the RE
{
	const b = collectBackups();
	const newest = b.recent[0];
	const second = b.recent[1];
	check('populated → exactly 3 returned', b.recent.length === 3);
	check('populated → newest first', newest?.name === 'morphit-20260604-040000.sql.gz');
	check('populated → second newest (.age)', second?.name === 'morphit-20260603-040000.sql.gz.age');
	check('populated → .age variant counted', b.recent.some((r) => r.name.endsWith('.age')));
	check(
		'populated → non-backup files ignored',
		!b.recent.some((r) => r.name === 'notes.txt' || r.name === 'morphit-bad.sql.gz')
	);
	check('populated → size captured', newest?.size_bytes === 400);
	check('populated → note null', b.note === null);
	check('populated → modified_at ISO', (newest?.modified_at ?? '').includes('T'));
}
rmSync(dir, { recursive: true, force: true });

// ── 9. STATIC: read-only invariant ──
{
	const here = dirname(fileURLToPath(import.meta.url));
	const src = readFileSync(join(here, '..', 'src', 'commands', 'status.ts'), 'utf8');
	const mutators = [
		'writeFileSync',
		'mkdirSync',
		'unlinkSync',
		'rmSync',
		'rmdirSync',
		'renameSync',
		'appendFileSync',
		'chmodSync',
		'cpSync'
	];
	const hit = mutators.find((m) => src.includes(m));
	check(`status.ts performs no fs mutation (read-only dashboard)${hit ? ` — found ${hit}` : ''}`, hit === undefined);
}

// restore env
setDir(ORIG);

if (failures.length > 0) {
	console.error(`\n✗ ${failures.length} status-backups scenario(s) failed`);
	process.exit(1);
}
console.log(`✓ all ${passed} status-backups scenarios passed`);
