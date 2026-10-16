/**
 * /etc/morphit/relay-notify.env is SOURCED by bash when the relay starts. A
 * password with a space, a quote, a `$` or a backtick must come back out of
 * bash exactly as typed — and must never run anything. Checked against real
 * bash, the way the relay unit reads it.
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	linkSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	parseNotifyEnv,
	parseShellValue,
	readNotifyEnv,
	renderNotifyEnv,
	shellQuote,
	withoutChannel,
	writableValue,
	writeNotifyEnv
} from '../src/lib/offlineNotifyEnv.ts';

/** What bash makes of the file, as the relay unit sources it. Bash runs in
 *  the file's own folder, so anything a value made it run (`touch PWNED`)
 *  lands where the test looks for it — never in the folder the tests run in. */
function sourced(file: string, keys: readonly string[]): Record<string, string> {
	const r = spawnSync(
		'bash',
		[
			'-c',
			`set -a; . "$1"; set +a; for k in ${keys.join(' ')}; do printf '%s\\0' "\${!k}"; done`,
			'x',
			file
		],
		{ encoding: 'utf8', cwd: dirname(file) }
	);
	expect(r.status, r.stderr).toBe(0);
	const vals = r.stdout.split('\0');
	return Object.fromEntries(keys.map((k, i) => [k, vals[i] ?? '']));
}

describe('relay-notify.env', () => {
	const nasty = [
		'plain',
		'with space',
		"it's",
		'$HOME and `id` and $(touch PWNED)',
		'back\\slash "double" quotes',
		'abandon ability able about above absent absorb abstract absurd abuse access accident account',
		"''''",
		'trailing space '
	];

	it('bash reads every value back exactly, and runs none of it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notify-env-'));
		try {
			const values: Record<string, string> = {};
			nasty.forEach((v, i) => (values[`MORPHIT_NOTIFY_X_${i}`] = v));
			values.MORPHIT_NOTIFY_EMAIL_PASSWORD = nasty[3]!;
			values.MORPHIT_NOTIFY_SESSION_MNEMONIC = nasty[5]!;
			const file = join(dir, 'relay-notify.env');
			writeFileSync(file, renderNotifyEnv(values));
			const back = sourced(file, Object.keys(values));
			expect(back).toEqual(values);
			expect(existsSync(join(dir, 'PWNED'))).toBe(false);
			// …and this module reads back what it wrote.
			expect(parseNotifyEnv(readFileSync(file, 'utf8'))).toEqual(values);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('refuses a value with a line break (it would start a new line of shell)', () => {
		expect(() => renderNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: 'a\nreboot' })).toThrow(
			/line break/
		);
		expect(() => renderNotifyEnv({ 'BAD KEY': 'x' })).toThrow(/not a setting name/);
	});

	it('reads a hand-edited file the way bash would (plain, double-quoted, last wins)', () => {
		expect(
			parseNotifyEnv(
				[
					'# comment',
					'MORPHIT_NOTIFY_EMAIL_HOST=mail.example.org',
					'export MORPHIT_NOTIFY_EMAIL_USER="ops@example.org"',
					`MORPHIT_NOTIFY_EMAIL_PASSWORD=${shellQuote("it's")}`,
					'MORPHIT_NOTIFY_EMAIL_HOST=smtp.example.org',
					'not a line'
				].join('\n')
			)
		).toEqual({
			MORPHIT_NOTIFY_EMAIL_HOST: 'smtp.example.org',
			MORPHIT_NOTIFY_EMAIL_USER: 'ops@example.org',
			MORPHIT_NOTIFY_EMAIL_PASSWORD: "it's"
		});
	});

	it('turning a channel off removes all its settings and keeps the others', () => {
		const v = {
			MORPHIT_NOTIFY_EMAIL_HOST: 'h',
			MORPHIT_NOTIFY_EMAIL_PASSWORD: 'p',
			MORPHIT_NOTIFY_TELEGRAM_TOKEN: 't'
		};
		expect(withoutChannel(v, 'email')).toEqual({ MORPHIT_NOTIFY_TELEGRAM_TOKEN: 't' });
	});

	it('is written in one step, never readable by others', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notify-env-'));
		try {
			const file = join(dir, 'relay-notify.env');
			// A group that does not exist here: root-only, 0600.
			writeNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: 's3cret' }, file, 'no-such-group-xyz');
			expect(statSync(file).mode & 0o777).toBe(0o600);
			// The relay's group where there is one (here: an existing system group).
			writeNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: 's3cret' }, file, 'daemon');
			const st = statSync(file);
			expect(st.mode & 0o777).toBe(0o640);
			expect(st.uid).toBe(0);
			expect(spawnSync('ls', [dir]).stdout.toString().trim()).toBe('relay-notify.env');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Review R5 #5: U+2028 / U+2029 end a line for JavaScript's `^…$` (other
	// readers of the relay's env files use that): refused like \n.
	it('refuses U+2028 and U+2029 as well as \\r, \\n and NUL', () => {
		for (const bad of ['a\u2028b', 'a\u2029b', 'a\rb', 'a\nb', 'a\0b']) {
			expect(writableValue(bad), JSON.stringify(bad)).toBe(false);
			expect(() => renderNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: bad })).toThrow(/line break/);
			expect(() => renderNotifyEnv({ MORPHIT_NOTIFY_X: bad }, 'A=1\n')).toThrow(/line break/);
		}
		expect(writableValue('pa$$ word \u00e9\u200b')).toBe(true);
	});

	it('reads values the way bash does: a comment after a quoted value, lowercase names, nothing it cannot know', () => {
		expect(
			parseNotifyEnv(
				[
					"MORPHIT_NOTIFY_EMAIL_PASSWORD='s3cret' # rotated 2026-10",
					"https_proxy='socks5h://127.0.0.1:9050'",
					'MORPHIT_NOTIFY_EMAIL_USER="ops@example.org"   # the login',
					'MORPHIT_NOTIFY_EMAIL_PORT=587 # usual',
					'MORPHIT_NOTIFY_EMAIL_HOST=smtp.example.org',
					'MORPHIT_NOTIFY_EMAIL_HOST=$(cat /root/host)',
					'MORPHIT_NOTIFY_XMPP_JID=a b',
					"MORPHIT_NOTIFY_TELEGRAM_TOKEN='unclosed"
				].join('\n')
			)
		).toEqual({
			MORPHIT_NOTIFY_EMAIL_PASSWORD: 's3cret',
			https_proxy: 'socks5h://127.0.0.1:9050',
			MORPHIT_NOTIFY_EMAIL_USER: 'ops@example.org',
			MORPHIT_NOTIFY_EMAIL_PORT: '587'
		});
		expect(parseShellValue('"a\\$b"')).toBe('a$b');
		expect(parseShellValue('"$HOME"')).toBeNull();
		expect(parseShellValue('~/x')).toBeNull();
		expect(parseShellValue("'it'\\''s'")).toBe("it's");
	});

	/** The reviewer's file (R5 parse-drop): a comment after a quoted value, a
	 *  value bash reads with U+2028 in it, a lowercase setting, plus an
	 *  operator's comment and lines morphit-ops cannot read. */
	const HAND = [
		'# my notes: rotated by hand',
		"MORPHIT_NOTIFY_EMAIL_HOST='smtp.example.org'",
		"MORPHIT_NOTIFY_EMAIL_PASSWORD='s3cret' # rotated 2026-10",
		"MORPHIT_NOTIFY_XMPP_PASSWORD='pass\u2028word'",
		"https_proxy='socks5h://127.0.0.1:9050'",
		'MORPHIT_NOTIFY_SESSION_MNEMONIC=$(cat /root/words)',
		'some line bash would run',
		"MORPHIT_NOTIFY_TELEGRAM_TOKEN='111:tok'",
		"MORPHIT_NOTIFY_TELEGRAM_USERNAME='OldBot'",
		''
	].join('\n');

	it('a save keeps every line it does not change, exactly as it was', () => {
		// Turning Telegram off: its two lines go, nothing else changes.
		const out = renderNotifyEnv(withoutChannel(parseNotifyEnv(HAND), 'telegram'), HAND, [
			'telegram'
		]);
		expect(out).toBe(
			HAND.replace("MORPHIT_NOTIFY_TELEGRAM_TOKEN='111:tok'\n", '').replace(
				"MORPHIT_NOTIFY_TELEGRAM_USERNAME='OldBot'\n",
				''
			)
		);
	});

	it('changing a setting rewrites only its own line; a new one goes beside its channel', () => {
		const v = parseNotifyEnv(HAND);
		const out = renderNotifyEnv(
			{
				...withoutChannel(v, 'email'),
				MORPHIT_NOTIFY_EMAIL_HOST: 'smtp.example.org',
				MORPHIT_NOTIFY_EMAIL_PASSWORD: "n'ew",
				MORPHIT_NOTIFY_EMAIL_FROM: 'n@example.org'
			},
			HAND,
			['email']
		);
		const lines = out.split('\n');
		expect(lines[1]).toBe("MORPHIT_NOTIFY_EMAIL_HOST='smtp.example.org'");
		expect(lines[2]).toBe(`MORPHIT_NOTIFY_EMAIL_PASSWORD=${shellQuote("n'ew")}`);
		expect(lines[3]).toBe("MORPHIT_NOTIFY_EMAIL_FROM='n@example.org'");
		// Everything else as it was.
		expect(out.replace(/^MORPHIT_NOTIFY_EMAIL_.*\n/gm, '')).toBe(
			HAND.replace(/^MORPHIT_NOTIFY_EMAIL_.*\n/gm, '')
		);
	});

	it('turning a channel off removes its lines even where they cannot be read; others stay', () => {
		const out = renderNotifyEnv(withoutChannel(parseNotifyEnv(HAND), 'session'), HAND, ['session']);
		expect(out).not.toContain('MORPHIT_NOTIFY_SESSION_MNEMONIC');
		expect(out).toBe(HAND.replace('MORPHIT_NOTIFY_SESSION_MNEMONIC=$(cat /root/words)\n', ''));
	});

	it('writeNotifyEnv: an operator’s hand-edited file survives a save, and bash still reads it the same', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notify-env-'));
		try {
			const file = join(dir, 'relay-notify.env');
			writeFileSync(file, HAND);
			const keys = ['MORPHIT_NOTIFY_EMAIL_PASSWORD', 'MORPHIT_NOTIFY_XMPP_PASSWORD', 'https_proxy'];
			const strip = HAND.replace(/^.*(?:\$\(cat|some line).*\n/gm, '');
			writeFileSync(join(dir, 'probe.env'), strip);
			const before = sourced(join(dir, 'probe.env'), keys);
			writeNotifyEnv(withoutChannel(readNotifyEnv(file), 'telegram'), file, 'daemon', ['telegram']);
			const after = readFileSync(file, 'utf8');
			for (const line of HAND.split('\n').filter((l) => l !== '' && !l.includes('TELEGRAM')))
				expect(after.split('\n')).toContain(line);
			expect(after).not.toContain('TELEGRAM');
			writeFileSync(join(dir, 'probe.env'), after.replace(/^.*(?:\$\(cat|some line).*\n/gm, ''));
			expect(sourced(join(dir, 'probe.env'), keys)).toEqual(before);
			expect(before.MORPHIT_NOTIFY_EMAIL_PASSWORD).toBe('s3cret');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Review E3: a reader (the relay starting) must see the old file or the new
	// one, never a half-written one — a new file renamed into place, never the
	// old one rewritten.
	it('is replaced by a new file, never rewritten in place', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notify-env-'));
		try {
			const file = join(dir, 'relay-notify.env');
			writeNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: 'old' }, file, 'daemon');
			const oldIno = statSync(file).ino;
			// A second name for the old file: what an open reader still sees.
			linkSync(file, join(dir, 'old-copy'));
			writeNotifyEnv({ MORPHIT_NOTIFY_EMAIL_PASSWORD: 'new' }, file, 'daemon');
			expect(statSync(file).ino).not.toBe(oldIno);
			expect(readFileSync(join(dir, 'old-copy'), 'utf8')).toContain("='old'");
			expect(readFileSync(file, 'utf8')).toContain("='new'");
			expect(readdirSync(dir).sort()).toEqual(['old-copy', 'relay-notify.env']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('refuses a path that is a link (and leaves what it points at alone)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notify-env-'));
		try {
			const target = join(dir, 'elsewhere');
			writeFileSync(target, 'ROOT_ONLY=1\n', { mode: 0o600 });
			symlinkSync(target, join(dir, 'relay-notify.env'));
			expect(() =>
				writeNotifyEnv(
					{ MORPHIT_NOTIFY_EMAIL_PASSWORD: 'x' },
					join(dir, 'relay-notify.env'),
					'daemon'
				)
			).toThrow(/not a regular file/);
			expect(readFileSync(target, 'utf8')).toBe('ROOT_ONLY=1\n');
			expect(statSync(target).mode & 0o777).toBe(0o600);
			expect(readNotifyEnv(join(dir, 'relay-notify.env'))).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
