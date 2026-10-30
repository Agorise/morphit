/**
 * Typed commands run without sudo, and the relay account a server's views are
 * about (review v1.21.18) — real `morphit-ops` runs (src/main.ts) in a child
 * process, as the unprivileged user `nobody` where it matters, from a stand-in
 * install whose settings file is root-only, as on a real server:
 *  - only the menu checked for root: typed, `doctor`, `status`,
 *    `edit-active-key` … failed part-way with a raw EACCES or advice that was
 *    not true; now they say up front to run it with sudo, with the exact
 *    command typed — and the commands that already look after a run without
 *    sudo themselves (`upgrade --check-only`, `branding status`, `--help`)
 *    still run;
 *  - a database view on an INSTALLED server without sudo said "No database URL
 *    configured. Set one of: …" — settings nobody should set by hand there;
 *  - with no relay account set, the views showed morphit.io's relay
 *    ("morphit-relay"), on every server.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const OPS = resolve(import.meta.dirname, '..');
const TSX = resolve(OPS, '..', '..', 'node_modules', '.bin', 'tsx');
const MAIN = join(OPS, 'src', 'main.ts');
const asRoot = process.getuid?.() === 0;

const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A stand-in install: the monorepo marker and a root-only morphit.env. */
function install(morphitEnv: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-sudo-'));
	made.push(dir);
	chmodSync(dir, 0o755);
	writeFileSync(join(dir, 'package.json'), '{"name":"stand-in","private":true,"workspaces":[]}');
	writeFileSync(join(dir, 'morphit.env'), morphitEnv, { mode: 0o600 });
	return dir;
}

const ENV_FILE =
	'MORPHIT_RELAY_ACCOUNT=alice-relay\nMORPHIT_INDEXER_DATABASE_URL=postgres://u:p@127.0.0.1:1/db\n';

/** `morphit-ops ...args` from `cwd`, as `nobody` (or as root), with a clean
 *  environment: no database address, no relay account, no network. */
function run(
	cwd: string,
	args: readonly string[],
	opts: { nobody?: boolean; env?: Record<string, string> } = {}
): { out: string; code: number | null } {
	const cmd = opts.nobody
		? ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', TSX, MAIN, ...args]
		: [TSX, MAIN, ...args];
	const r = spawnSync(cmd[0]!, cmd.slice(1), {
		cwd,
		encoding: 'utf8',
		timeout: 90_000,
		input: '',
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: cwd,
			TSX_DISABLE_CACHE: '1',
			MORPHIT_OPS_COLOR: 'never',
			HTTPS_PROXY: 'http://127.0.0.1:9',
			HTTP_PROXY: 'http://127.0.0.1:9',
			...(opts.env ?? {})
		}
	});
	return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status };
}

const SUDO_LINE = 'That needs administrator rights on this server. Run it with sudo:';

describe.skipIf(!asRoot)('a typed command that needs root, run without sudo', () => {
	it.each([
		[['doctor', '--no-rpc'], 'sudo morphit-ops doctor --no-rpc'],
		[['edit-active-key', '--keep-backup'], 'sudo morphit-ops edit-active-key --keep-backup'],
		[['status'], 'sudo morphit-ops status'],
		[['matrix', 'test'], 'sudo morphit-ops matrix test'],
		[['branding', 'setup'], 'sudo morphit-ops branding setup']
	])(
		'%j: says so up front, with the exact command',
		(args, sudo) => {
			const r = run(install(ENV_FILE), args, { nobody: true });
			expect(r.out).toContain(SUDO_LINE);
			expect(r.out).toContain(sudo);
			expect(r.out).not.toMatch(/EACCES|EPERM|fatal|No database URL/);
			expect(r.code).toBe(1);
		},
		120_000
	);

	it('the commands that look after it themselves still run: upgrade --check-only, branding status, --help', () => {
		const dir = install(ENV_FILE);
		const check = run(dir, ['upgrade', '--check-only'], { nobody: true });
		expect(check.out).not.toContain(SUDO_LINE);
		expect(check.out).toMatch(/latest release/);
		const help = run(dir, ['doctor', '--help'], { nobody: true });
		expect(help.out).toContain('morphit-ops — Morphit operator command-line tool');
		expect(help.code).toBe(0);
		const brand = run(dir, ['branding', 'status'], { nobody: true });
		expect(brand.out).not.toContain(SUDO_LINE);
	}, 240_000);

	it('a database view whose database this run names itself is not stopped for sudo', () => {
		const r = run(install(ENV_FILE), ['status'], {
			nobody: true,
			env: { MORPHIT_OPS_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' }
		});
		expect(r.out).not.toContain(SUDO_LINE);
		// …and the relay account it cannot read is not guessed: it says why.
		expect(r.out).toContain('cannot be read as this user, so its relay account is not known');
		expect(r.out).toContain('sudo morphit-ops status');
		expect(r.out).not.toContain('morphit-relay');
	}, 120_000);
});

describe.skipIf(!asRoot)('a database command on an installed server, without sudo', () => {
	it('says to run it with sudo — the exact command, quoted — not which settings to set', () => {
		// `block` is not on the menu's needs-root list: it gets here through the
		// database settings it cannot read.
		const r = run(install(ENV_FILE), ['block', 'bad guy', '--reason', "it's spam"], {
			nobody: true
		});
		expect(r.out).toContain('its database settings can only be read with sudo');
		expect(r.out).toContain(`sudo morphit-ops block 'bad guy' --reason 'it'\\''s spam'`);
		expect(r.out).not.toContain('Set one of');
	}, 120_000);
});

describe("this server's relay account, when its settings do not name it", () => {
	const NO_RELAY = 'MORPHIT_INDEXER_DATABASE_URL=postgres://u:p@127.0.0.1:1/db\n';
	it.each(['signups', 'status'])(
		'%s says it is not set and how to set it — never shows another server’s',
		(sub) => {
			const dir = install(NO_RELAY);
			const r = run(dir, [sub]);
			expect(r.out).toContain("This server's relay account is not set");
			expect(r.out).toContain(`MORPHIT_RELAY_ACCOUNT line in ${join(dir, 'morphit.env')}`);
			expect(r.out).toContain(`sudo nano ${join(dir, 'morphit.env')}`);
			expect(r.out).toContain(`sudo morphit-ops ${sub}`);
			expect(r.out).not.toContain('morphit-relay');
			// Stopped before the database was asked anything.
			expect(r.out).not.toMatch(/database is not answering|ECONNREFUSED/);
			expect(r.code).toBe(1);
		},
		120_000
	);
});

describe('--help says what the commands do', () => {
	const help = (): string => run(OPS, ['--help']).out;
	it('flags: all four kinds, and --since=all', () => {
		const h = help();
		expect(h).toContain('flags [--type=reciprocity|related|pile_on|concentration] [--since=DUR]');
		expect(h).toMatch(/--since=all/);
	}, 60_000);
	it('moderation: clear and undo, all time by default', () => {
		const h = help();
		const at = h.indexOf('moderation [');
		const block = h.slice(at, h.indexOf('flags [', at));
		expect(block).toMatch(/all time by default/);
		expect(block).toMatch(/clear a flag/);
		expect(block).toMatch(/undo a clearance/);
	}, 60_000);
	it('offline-notify: no claim that an untested account is marked (nothing is kept)', () => {
		const h = help().replace(/\s+/g, ' ');
		expect(h).not.toMatch(/marked not tested|marked as not tested|shown as not tested/);
		// Per app what tests it (Telegram sends no note; email cannot skip it).
		expect(h).not.toMatch(/Each is tested by a test note/);
		expect(h).toContain('Session is tested only by a test note, which you may skip');
	}, 60_000);
});
