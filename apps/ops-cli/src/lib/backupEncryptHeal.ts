/**
 * Plain-text database backups already on an installed box.
 *
 * The nightly backup writes `morphit-<time>.sql.gz` into BACKUP_DIR and keeps
 * each for RETAIN_DAYS unless backup.env names an age public key
 * (AGE_RECIPIENT). The install wizard now offers that key; boxes installed
 * before it hold weeks of readable dumps. With the operator's answer (never
 * without it):
 *   - an age public key (or ENCRYPT, when backup.env already names one): the
 *     key goes into backup.env (read back), every plain-text backup is
 *     encrypted next to itself as `<name>.age` (same owner, 0600, same mtime so
 *     the retention still applies), checked to be an age file, and only then
 *     the plain-text one is removed;
 *   - DELETE: the plain-text backups are removed (future ones stay plain text
 *     until a key is set);
 *   - Enter: nothing changes and the choice is recorded, so later upgrades do
 *     not ask again.
 * With no answer (no terminal, or none in time), it only says what it found
 * and the command to run.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	chownSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';

export const BACKUP_ENV = '/etc/morphit/backup.env';
export const BACKUP_PLAINTEXT_DECISION = '/etc/morphit/backup-plaintext.decision';
const AGE_RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;
const PLAIN_RE = /^morphit-.*\.sql\.gz$/;

export interface BackupRuntime {
	readEnv(): string | null;
	writeEnv(text: string): void;
	list(dir: string): string[];
	/** Encrypt `file` to `recipient` as `file.age`; true when an age file is there. */
	encrypt(file: string, recipient: string): boolean;
	remove(file: string): void;
	exists(file: string): boolean;
	decided(): boolean;
	recordDecision(text: string): void;
	/** The operator's answer, or null when there is no terminal to ask. */
	ask(question: string): Promise<string | null>;
}

const envValue = (text: string, key: string): string | null => {
	const m = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'm').exec(text);
	return m ? (m[1] ?? '').trim().replace(/^["']|["']$/g, '') : null;
};

/** backup.env with AGE_RECIPIENT set to `recipient` (replaced or appended). PURE. */
export function withAgeRecipient(text: string, recipient: string): string {
	const line = `AGE_RECIPIENT=${recipient}`;
	if (/^[ \t]*AGE_RECIPIENT[ \t]*=.*$/m.test(text))
		return text.replace(/^[ \t]*AGE_RECIPIENT[ \t]*=.*$/m, line);
	return `${text.replace(/\n*$/, '\n')}\n# Daily backups are encrypted to this age public key (set by morphit-ops upgrade).\n${line}\n`;
}

export async function healBackupEncryption(ctx: HealCtx, rt: BackupRuntime): Promise<HealResult> {
	const env = rt.readEnv();
	if (env === null) return { strategy: 'no-backups', verified: true, detail: '' };
	const dir = envValue(env, 'BACKUP_DIR') ?? '';
	if (dir === '') return { strategy: 'no-backups', verified: true, detail: '' };
	const existingKey = envValue(env, 'AGE_RECIPIENT') ?? '';
	const keyOk = AGE_RECIPIENT_RE.test(existingKey);
	const plain = rt
		.list(dir)
		.filter((n) => PLAIN_RE.test(n))
		.map((n) => join(dir, n));
	if (plain.length === 0) return { strategy: 'already', verified: true, detail: '' };
	if (rt.decided()) return { strategy: 'kept-by-choice', verified: true, detail: '' };

	const what = `${plain.length} database backup${plain.length === 1 ? '' : 's'} in ${dir} ${plain.length === 1 ? 'is' : 'are'} in plain text`;
	const answer = await rt.ask(
		`${what} — anyone with this disk, or a copy of it, can read ${plain.length === 1 ? 'it' : 'them'}.\n` +
			(keyOk
				? `  Type ENCRYPT to encrypt ${plain.length === 1 ? 'it' : 'them'} to the age key in ${BACKUP_ENV}, `
				: '  Paste an age public key (age1…; make one on YOUR computer with `age-keygen -o morphit-backup-key.txt`) to encrypt them and every future backup, ') +
			'type DELETE to delete them now, or press Enter to leave them as they are.'
	);
	if (answer === null) {
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Backups: ${what}. Nothing was changed (not asked during the upgrade). To encrypt or delete them: sudo morphit-ops upgrade --questions`
		};
	}
	const a = answer.trim();
	if (a === '') {
		rt.recordDecision(`kept plain-text backups ${new Date().toISOString()}\n`);
		return {
			strategy: 'kept-by-choice',
			verified: true,
			detail: `Backups: left as they are (your choice, recorded in ${BACKUP_PLAINTEXT_DECISION}; you will not be asked again).`
		};
	}
	if (a === 'DELETE') {
		for (const f of plain) rt.remove(f);
		const left = plain.filter((f) => rt.exists(f));
		return left.length === 0
			? {
					strategy: 'deleted',
					verified: true,
					detail: `Backups: deleted ${plain.length} plain-text backup${plain.length === 1 ? '' : 's'}.${keyOk ? '' : ' New ones are still plain text until an age key is set (sudo morphit-ops upgrade --questions, then paste one).'}`
				}
			: {
					strategy: 'failed',
					verified: false,
					detail: `Backups: ${left.length} could not be deleted; on this server run: sudo rm ${left.join(' ')}`
				};
	}
	let recipient = existingKey;
	if (!(a === 'ENCRYPT' && keyOk)) {
		if (!AGE_RECIPIENT_RE.test(a)) {
			return {
				strategy: 'left-alone',
				verified: false,
				detail: /^AGE-SECRET-KEY-1/i.test(a)
					? 'Backups: that was an age SECRET key — nothing was changed. Keep it off this server; paste its PUBLIC key (age1…) instead: sudo morphit-ops upgrade --questions'
					: 'Backups: that is not an age public key (age1…, 62 characters); nothing was changed. To try again: sudo morphit-ops upgrade --questions'
			};
		}
		recipient = a;
		rt.writeEnv(withAgeRecipient(env, recipient));
		if (envValue(rt.readEnv() ?? '', 'AGE_RECIPIENT') !== recipient) {
			return {
				strategy: 'failed',
				verified: false,
				detail: `Backups: could not write the key to ${BACKUP_ENV}; nothing else was changed. Add the line AGE_RECIPIENT=${recipient} there yourself.`
			};
		}
	}
	const stop = ctx.spinner(`Encrypting ${plain.length} backup${plain.length === 1 ? '' : 's'}…`);
	const failed: string[] = [];
	try {
		for (const f of plain) {
			if (rt.encrypt(f, recipient)) rt.remove(f);
			else failed.push(f);
		}
	} finally {
		stop();
	}
	const stillPlain = plain.filter((f) => rt.exists(f));
	if (failed.length === 0 && stillPlain.length === 0) {
		return {
			strategy: 'encrypted',
			verified: true,
			detail: `Backups: ${plain.length} encrypted to your age key and the plain-text copies removed; every new backup is encrypted to it too. Only your secret key file can restore them — keep it safe, off this server.`
		};
	}
	return {
		strategy: 'partly',
		verified: false,
		detail: `Backups: ${failed.length} could not be encrypted and stay in plain text (${failed.join(', ')}); new backups are encrypted. Retry with the next upgrade, or delete them: sudo rm ${failed.join(' ')}`
	};
}

const isAgeFile = (path: string): boolean => {
	try {
		const fd = openSync(path, 'r');
		try {
			const b = Buffer.alloc(22);
			readSync(fd, b, 0, 22, 0);
			return b.toString('ascii') === 'age-encryption.org/v1\n';
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
};

export function realBackupRuntime(
	ask: (q: string) => Promise<string | null>,
	paths: { env?: string; decision?: string } = {}
): BackupRuntime {
	const envPath = paths.env ?? BACKUP_ENV;
	const decision = paths.decision ?? BACKUP_PLAINTEXT_DECISION;
	return {
		readEnv: () => (existsSync(envPath) ? readFileSync(envPath, 'utf8') : null),
		writeEnv: (text) => {
			const st = statSync(envPath);
			const tmp = `${envPath}.new`;
			writeFileSync(tmp, text, { mode: st.mode & 0o777 });
			chownSync(tmp, st.uid, st.gid);
			renameSync(tmp, envPath);
		},
		list: (dir) => {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
		encrypt: (file, recipient) => {
			const out = `${file}.age`;
			const tmp = `${out}.partial`;
			rmSync(tmp, { force: true });
			const r = spawnSync('age', ['-r', recipient, '-o', tmp, file], { timeout: 600_000 });
			if (r.status !== 0 || !isAgeFile(tmp)) {
				rmSync(tmp, { force: true });
				return false;
			}
			const st = statSync(file);
			chmodSync(tmp, 0o600);
			chownSync(tmp, st.uid, st.gid);
			renameSync(tmp, out);
			utimesSync(out, st.atime, st.mtime);
			return isAgeFile(out);
		},
		remove: (file) => rmSync(file, { force: true }),
		exists: (file) => existsSync(file),
		decided: () => existsSync(decision),
		recordDecision: (text) => {
			mkdirSync(dirname(decision), { recursive: true });
			writeFileSync(decision, text, { mode: 0o644 });
		},
		ask
	};
}
