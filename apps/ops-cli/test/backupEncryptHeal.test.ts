/**
 * Plain-text database backups already on an installed box are encrypted or
 * deleted on the operator's word.
 * Real files, the real `age` (the encryption case is skipped where age is not
 * installed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { healBackupEncryption, realBackupRuntime } from '../src/lib/backupEncryptHeal.ts';

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
let root = '';
let dir = '';
let envPath = '';
let decision = '';
const OLD = new Date('2026-09-20T04:00:00Z');

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-backup-heal-'));
	dir = join(root, 'backups');
	mkdirSync(dir);
	envPath = join(root, 'backup.env');
	decision = join(root, 'backup-plaintext.decision');
	writeFileSync(envPath, `BACKUP_DIR=${dir}\nRETAIN_DAYS=30\nDB_NAME=morphit_indexer\n`, {
		mode: 0o600
	});
	for (const n of ['morphit-20260920-040000.sql.gz', 'morphit-20260921-040000.sql.gz']) {
		writeFileSync(join(dir, n), `dump ${n}`);
		utimesSync(join(dir, n), OLD, OLD);
	}
	writeFileSync(join(dir, 'morphit-20260919-040000.sql.gz.age'), 'age-encryption.org/v1\nalready');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (answer: string | null) =>
	healBackupEncryption(
		ctx,
		realBackupRuntime(async () => answer, { env: envPath, decision })
	);
const plainLeft = (): string[] =>
	['morphit-20260920-040000.sql.gz', 'morphit-20260921-040000.sql.gz'].filter((n) =>
		existsSync(join(dir, n))
	);

describe('plain-text backups on an installed box', () => {
	it('with no terminal to ask, changes nothing and says how', async () => {
		const r = await run(null);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/2 database backups .* plain text/);
		expect(r.detail).toMatch(/sudo morphit-ops upgrade --questions/);
		expect(plainLeft().length).toBe(2);
	});

	it('Enter leaves them, records the choice, and is not asked again', async () => {
		expect((await run('')).strategy).toBe('kept-by-choice');
		expect(existsSync(decision)).toBe(true);
		let asked = 0;
		const again = await healBackupEncryption(
			ctx,
			realBackupRuntime(async () => (asked++, 'DELETE'), { env: envPath, decision })
		);
		expect(asked).toBe(0);
		expect(again.detail).toBe('');
		expect(plainLeft().length).toBe(2);
	});

	it('DELETE removes the plain-text ones only', async () => {
		const r = await run('DELETE');
		expect(r.verified).toBe(true);
		expect(plainLeft()).toEqual([]);
		expect(existsSync(join(dir, 'morphit-20260919-040000.sql.gz.age'))).toBe(true);
	});

	it('a pasted SECRET key changes nothing', async () => {
		const r = await run(`AGE-SECRET-KEY-1${'Q'.repeat(58)}`);
		expect(r.detail).toMatch(/SECRET key/);
		expect(readFileSync(envPath, 'utf8')).not.toMatch(/AGE_RECIPIENT/);
		expect(plainLeft().length).toBe(2);
	});

	it('an age public key: written to backup.env, every backup encrypted to it (decrypts back), plain text gone, dates kept', async () => {
		const kg = spawnSync('age-keygen', ['-o', join(root, 'key.txt')], { encoding: 'utf8' });
		if (kg.status !== 0) return; // age not installed here
		const pub = /public key: (age1\S+)/i.exec(`${kg.stderr}${kg.stdout}`)![1]!;
		const r = await run(pub);
		expect(r.strategy, r.detail).toBe('encrypted');
		expect(readFileSync(envPath, 'utf8')).toMatch(new RegExp(`^AGE_RECIPIENT=${pub}$`, 'm'));
		expect(statSync(envPath).mode & 0o777).toBe(0o600);
		expect(plainLeft()).toEqual([]);
		for (const n of ['morphit-20260920-040000.sql.gz', 'morphit-20260921-040000.sql.gz']) {
			const enc = join(dir, `${n}.age`);
			expect(readFileSync(enc, 'utf8').startsWith('age-encryption.org/v1\n')).toBe(true);
			expect(statSync(enc).mode & 0o777).toBe(0o600);
			expect(statSync(enc).mtime.getTime()).toBe(OLD.getTime());
			const d = spawnSync('age', ['-d', '-i', join(root, 'key.txt'), enc], { encoding: 'utf8' });
			expect(d.stdout).toBe(`dump ${n}`);
		}
	});

	it('ENCRYPT uses the key backup.env already names', async () => {
		const kg = spawnSync('age-keygen', ['-o', join(root, 'key.txt')], { encoding: 'utf8' });
		if (kg.status !== 0) return;
		const pub = /public key: (age1\S+)/i.exec(`${kg.stderr}${kg.stdout}`)![1]!;
		writeFileSync(envPath, `${readFileSync(envPath, 'utf8')}AGE_RECIPIENT=${pub}\n`);
		const r = await run('ENCRYPT');
		expect(r.strategy, r.detail).toBe('encrypted');
		expect(plainLeft()).toEqual([]);
	});
});
