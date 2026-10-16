/**
 * /etc/morphit/relay-notify.env — the accounts this site sends offline notices
 * from (Settings → Offline Notifications): the mail server login, the Matrix
 * and XMPP bot accounts, the Telegram bot token, the Session recovery words.
 *
 * The relay unit SOURCES this file with bash (ExecStart's `. "$f"` loop), so
 * every value is written single-quoted — a password with a space, a `$` or a
 * backtick must stay a password, never become a command. A value that cannot
 * be written safely (a line break of any kind, a NUL) is refused.
 *
 * An operator may edit the file by hand. A save changes only the lines of the
 * settings it changes: every other line — a comment, a setting this module
 * does not know (lowercase names too), a line it cannot read the way bash
 * would — is kept exactly as it was.
 *
 * root:morphit-relay 0640: the relay reads it, the indexer (in the shared
 * service group) does not. ops/scripts/morphit-service-perms.sh keeps it so.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
	closeSync,
	constants as fsConstants,
	fchmodSync,
	fchownSync,
	fsyncSync,
	lstatSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readNoFollow } from './noFollowFs.ts';

export const NOTIFY_ENV_PATH = '/etc/morphit/relay-notify.env';
export const NOTIFY_GROUP = 'morphit-relay';

export type NotifyChannel = 'matrix' | 'session' | 'xmpp' | 'telegram' | 'email';
/** The order the Settings card shows them in. */
export const NOTIFY_CHANNELS: readonly NotifyChannel[] = [
	'matrix',
	'session',
	'xmpp',
	'telegram',
	'email'
];

/** Every key of each channel, in the order they are written. */
export const CHANNEL_KEYS: Readonly<Record<NotifyChannel, readonly string[]>> = {
	matrix: [
		'MORPHIT_NOTIFY_MATRIX_HOMESERVER',
		'MORPHIT_NOTIFY_MATRIX_TOKEN',
		'MORPHIT_NOTIFY_MATRIX_USER_ID'
	],
	session: ['MORPHIT_NOTIFY_SESSION_MNEMONIC'],
	xmpp: [
		'MORPHIT_NOTIFY_XMPP_JID',
		'MORPHIT_NOTIFY_XMPP_PASSWORD',
		'MORPHIT_NOTIFY_XMPP_HOST',
		'MORPHIT_NOTIFY_XMPP_PORT',
		'MORPHIT_NOTIFY_XMPP_SECURITY'
	],
	telegram: ['MORPHIT_NOTIFY_TELEGRAM_TOKEN', 'MORPHIT_NOTIFY_TELEGRAM_USERNAME'],
	email: [
		'MORPHIT_NOTIFY_EMAIL_HOST',
		'MORPHIT_NOTIFY_EMAIL_PORT',
		'MORPHIT_NOTIFY_EMAIL_SECURITY',
		'MORPHIT_NOTIFY_EMAIL_USER',
		'MORPHIT_NOTIFY_EMAIL_PASSWORD',
		'MORPHIT_NOTIFY_EMAIL_FROM'
	]
};

/** The key whose presence means "this channel has settings". */
export const CHANNEL_MAIN_KEY: Readonly<Record<NotifyChannel, string>> = {
	matrix: 'MORPHIT_NOTIFY_MATRIX_HOMESERVER',
	session: 'MORPHIT_NOTIFY_SESSION_MNEMONIC',
	xmpp: 'MORPHIT_NOTIFY_XMPP_JID',
	telegram: 'MORPHIT_NOTIFY_TELEGRAM_TOKEN',
	email: 'MORPHIT_NOTIFY_EMAIL_HOST'
};

/** A shell variable name (bash accepts lowercase ones too: https_proxy). */
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An assignment line, as bash reads one: `[export ]NAME=value`. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** A value bash reads back byte for byte: single-quoted, `'` as `'\''`. PURE. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Whether a value can be written to the file at all: no line break of any
 *  kind (U+2028 / U+2029 end a line for JavaScript's `^…$`, which other
 *  readers of these files use), no NUL. PURE. */
export function writableValue(value: string): boolean {
	return !/[\r\n\0\u2028\u2029]/.test(value);
}

/**
 * The value bash gives the right-hand side of an assignment line, or null
 * when it cannot be known without running something (`$…`, a backtick, a
 * second word, an unclosed quote, `~`). Single-quoted pieces, double-quoted
 * pieces without expansions, `\x` outside quotes, plain characters; a
 * `# comment` after whitespace ends it. PURE.
 */
export function parseShellValue(v: string): string | null {
	let out = '';
	let i = 0;
	while (i < v.length) {
		const ch = v[i]!;
		if (ch === "'") {
			const end = v.indexOf("'", i + 1);
			if (end === -1) return null;
			out += v.slice(i + 1, end);
			i = end + 1;
		} else if (ch === '"') {
			let j = i + 1;
			let closed = false;
			while (j < v.length) {
				const d = v[j]!;
				if (d === '"') {
					closed = true;
					break;
				}
				if (d === '$' || d === '`') return null;
				if (d === '\\' && j + 1 < v.length && /["\\$`]/.test(v[j + 1]!)) {
					out += v[j + 1];
					j += 2;
					continue;
				}
				out += d;
				j++;
			}
			if (!closed) return null;
			i = j + 1;
		} else if (ch === '\\') {
			if (i + 1 >= v.length) return null;
			out += v[i + 1];
			i += 2;
		} else if (ch === ' ' || ch === '\t') {
			// The end of the value: only a comment (or nothing) may follow.
			const rest = v.slice(i).trimStart();
			return rest === '' || rest.startsWith('#') ? out : null;
		} else if (/[$`;&|<>()~]/.test(ch)) {
			return null;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

interface Line {
	readonly raw: string;
	/** The variable it assigns, or null (a comment, a blank, anything else). */
	readonly key: string | null;
	/** Its value as bash reads it; null when that cannot be known. */
	readonly value: string | null;
}

function splitLines(text: string): Line[] {
	const raws = text.split('\n');
	if (raws.at(-1) === '') raws.pop();
	return raws.map((raw) => {
		const m = ASSIGNMENT.exec(raw);
		return m ? { raw, key: m[1]!, value: parseShellValue(m[2]!) } : { raw, key: null, value: null };
	});
}

/**
 * Read the file's assignments: `KEY='…'` as this module writes them, and the
 * plain `KEY=value` / `KEY="value"` (with a trailing `# comment`) a hand edit
 * may leave. Last assignment wins, as when bash sources it; a setting whose
 * last line cannot be read is left out. Comments and anything else are
 * skipped. PURE.
 */
export function parseNotifyEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const l of splitLines(text)) {
		if (l.key === null) continue;
		if (l.value === null) delete out[l.key];
		else out[l.key] = l.value;
	}
	return out;
}

function checkedLine(k: string, v: string): string {
	if (!KEY.test(k)) throw new Error(`${k}: not a setting name`);
	if (!writableValue(v)) throw new Error(`${k}: a value cannot contain a line break`);
	return `${k}=${shellQuote(v)}`;
}

const channelOf = (k: string): NotifyChannel | null =>
	NOTIFY_CHANNELS.find((ch) => CHANNEL_KEYS[ch].includes(k)) ?? null;

/**
 * The file's text for these values. PURE. Throws on a key or value that
 * cannot be written safely.
 *
 * With no `existing` text: a fresh file, channel by channel. With the file as
 * it is now: only the settings that change are touched. The keys of the
 * `owned` channels (default: all) are exactly what `values` says — one
 * missing from `values` is removed; any other setting is changed only where
 * `values` gives it a new value. Every other line is kept as it was.
 */
export function renderNotifyEnv(
	values: Readonly<Record<string, string>>,
	existing = '',
	owned: readonly NotifyChannel[] = NOTIFY_CHANNELS
): string {
	const want = (k: string): string | null => {
		const v = values[k];
		return v === undefined || v === '' ? null : v;
	};
	if (existing.trim() === '') {
		const lines = [
			'# Settings → Offline Notifications: the accounts this site sends its',
			'# notices from. Written by `sudo morphit-ops offline-notify`; sourced by the',
			'# relay (morphit-relay.service). root:morphit-relay 0640 — it holds passwords.',
			''
		];
		const written = new Set<string>();
		for (const ch of NOTIFY_CHANNELS) {
			const keys = CHANNEL_KEYS[ch].filter((k) => want(k) !== null);
			if (keys.length === 0) continue;
			lines.push(`# ${ch}`);
			for (const k of keys) {
				lines.push(checkedLine(k, values[k]!));
				written.add(k);
			}
			lines.push('');
		}
		// Anything else (a hand-added setting) is kept.
		for (const [k, v] of Object.entries(values)) {
			if (written.has(k) || v === '') continue;
			lines.push(checkedLine(k, v));
		}
		return `${lines.join('\n').replace(/\n+$/, '')}\n`;
	}

	const ownedKeys = new Set(owned.flatMap((ch) => CHANNEL_KEYS[ch]));
	const lines = splitLines(existing);
	/** Each key's last line, and what bash ends up with (null: unknown). */
	const last = new Map<string, number>();
	const has = new Map<string, string | null>();
	lines.forEach((l, i) => {
		if (l.key === null) return;
		last.set(l.key, i);
		has.set(l.key, l.value);
	});
	/** Settings whose lines this save rewrites: their final value changes. */
	const changes = (k: string): boolean => {
		const w = want(k);
		if (!ownedKeys.has(k) && w === null) return false; // not ours to remove
		const h = has.get(k);
		return h === undefined || h === null ? w !== null || h === null : h !== w;
	};
	const out: string[] = [];
	lines.forEach((l, i) => {
		if (l.key === null || !changes(l.key)) {
			out.push(l.raw);
			return;
		}
		const w = want(l.key);
		if (w !== null && last.get(l.key) === i) out.push(checkedLine(l.key, w));
	});
	// New settings: after the last line of their channel, else in a group of
	// their own at the end.
	const fresh = Object.keys(values).filter((k) => want(k) !== null && !has.has(k));
	const appended = new Map<NotifyChannel, string[]>();
	const tail: string[] = [];
	for (const k of fresh) {
		const ch = channelOf(k);
		const line = checkedLine(k, values[k]!);
		if (ch === null) tail.push(line);
		else appended.set(ch, [...(appended.get(ch) ?? []), line]);
	}
	for (const ch of NOTIFY_CHANNELS) {
		const add = appended.get(ch);
		if (add === undefined) continue;
		let at = -1;
		out.forEach((raw, i) => {
			const m = ASSIGNMENT.exec(raw);
			if (m && channelOf(m[1]!) === ch) at = i;
		});
		if (at >= 0) out.splice(at + 1, 0, ...add);
		else {
			if (out.length > 0 && out.at(-1)!.trim() !== '') out.push('');
			out.push(`# ${ch}`, ...add);
		}
	}
	out.push(...tail);
	return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** `values` with every key of `channel` removed. PURE. */
export function withoutChannel(
	values: Readonly<Record<string, string>>,
	channel: NotifyChannel
): Record<string, string> {
	const out = { ...values };
	for (const k of CHANNEL_KEYS[channel]) delete out[k];
	return out;
}

/** The file's settings ({} when there is none; never read through a link). */
export function readNotifyEnv(path: string = NOTIFY_ENV_PATH): Record<string, string> {
	return parseNotifyEnv(readNoFollow(path) ?? '');
}

function groupId(name: string): number | null {
	const r = spawnSync('getent', ['group', name], { encoding: 'utf8', timeout: 10_000 });
	const gid = Number(String(r.stdout ?? '').split(':')[2]);
	return r.status === 0 && Number.isInteger(gid) ? gid : null;
}

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_DIRECTORY } = fsConstants;

/**
 * Write the file atomically: a NEW temp file in the same directory (created
 * 0600, never through a link), owner and mode set on it, fsynced, then renamed
 * over the old one — root:morphit-relay 0640, or root:root 0600 where there is
 * no such group (a relay that runs as root). A reader sees the old file or the
 * new one, never half of one; on any failure the old file is left as it was
 * and the temp file removed. `owned`: see renderNotifyEnv. Refuses a path
 * that is a link or not a regular file.
 */
export function writeNotifyEnv(
	values: Readonly<Record<string, string>>,
	path: string = NOTIFY_ENV_PATH,
	group: string = NOTIFY_GROUP,
	owned: readonly NotifyChannel[] = NOTIFY_CHANNELS
): void {
	let existing = '';
	try {
		if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);
		const text = readNoFollow(path);
		if (text === null) throw new Error(`${path} could not be read`);
		existing = text;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
	}
	const text = renderNotifyEnv(values, existing, owned);
	const gid = groupId(group);
	const tmp = join(
		dirname(path),
		`.relay-notify.env.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
	);
	const fd = openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
	let renamed = false;
	try {
		try {
			const buf = Buffer.from(text, 'utf8');
			let off = 0;
			while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
			if (gid !== null) {
				fchownSync(fd, 0, gid);
				fchmodSync(fd, 0o640);
			} else {
				fchmodSync(fd, 0o600);
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
		renamed = true;
	} finally {
		if (!renamed) {
			try {
				unlinkSync(tmp);
			} catch {
				/* already gone */
			}
		}
	}
	// The rename itself survives a power cut.
	try {
		const dfd = openSync(dirname(path), O_RDONLY | O_DIRECTORY);
		try {
			fsyncSync(dfd);
		} finally {
			closeSync(dfd);
		}
	} catch {
		/* best effort */
	}
}
