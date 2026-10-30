/**
 * The bare `morphit-ops` menu, in a real terminal (review, 2026-10-29).
 *
 * - Ctrl+C at "Enter the number of your choice" printed
 *   "fatal: Aborted with Ctrl+C" and exited 127 (the code for "a command was
 *   not found"); Ctrl+D the same with "Ctrl+D". Both are the operator stopping:
 *   one plain "Stopped — …" line and 130.
 * - Run as root (`sudo morphit-ops`), every privileged item still carried
 *   "(needs sudo)". Run without sudo, picking one only failed part-way with a
 *   permission error; now it says up front to run it with sudo, and the menu
 *   says which items will work.
 * - The relay account is the one this server's own settings name
 *   (MORPHIT_RELAY_ACCOUNT in morphit.env), not always @morphit-relay.
 *
 * The terminal is a real pseudo-terminal (python's pty module).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { needsRoot, rootTag } from '../src/commands/mainMenu.ts';
import { loadThresholds, relayAccountFromEnv } from '../src/config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(HERE, '..');
const TSX = resolve(CLI_DIR, '..', '..', 'node_modules', '.bin', 'tsx');

const DRIVER = `
import json, os, pty, re, select, sys, time, signal
spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec["cwd"])
    os.execvpe(spec["cmd"][0], spec["cmd"], dict(os.environ, **spec["env"]))
buf, steps, deadline, status = b"", list(spec["steps"]), time.time() + 90, None
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        buf += data
    if steps and re.search(steps[0][0], buf.decode("utf-8", "replace"), re.S):
        time.sleep(0.2)
        os.write(fd, steps.pop(0)[1].encode())
else:
    os.kill(pid, signal.SIGKILL)
_, st = os.waitpid(pid, 0)
sys.stdout.write(buf.decode("utf-8", "replace"))
sys.stdout.write("\\n=== EXIT %d\\n" % os.waitstatus_to_exitcode(st))
`;

function drive(
	steps: [string, string][],
	opts: { asNobody?: boolean } = {}
): { out: string; code: number } {
	const dir = mkdtempSync(join(tmpdir(), 'menu-stops-'));
	const driver = join(dir, 'drive.py');
	writeFileSync(driver, DRIVER);
	let cmd = [TSX, 'src/main.ts'];
	// As root, drop to `nobody` for the without-sudo case.
	if (opts.asNobody === true && process.getuid?.() === 0) {
		cmd = ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', ...cmd];
	}
	const spec = {
		cmd,
		cwd: CLI_DIR,
		// No network for the menu's best-effort update check / balance marker.
		env: {
			MORPHIT_OPS_COLOR: 'never',
			HTTPS_PROXY: 'http://127.0.0.1:9',
			HTTP_PROXY: 'http://127.0.0.1:9',
			TSX_DISABLE_CACHE: '1',
			HOME: dir
		},
		steps
	};
	const r = spawnSync('python3', ['-I', driver, JSON.stringify(spec)], {
		encoding: 'utf8',
		timeout: 120_000
	});
	const out = r.stdout ?? '';
	const m = /=== EXIT (-?\d+)/.exec(out);
	return { out, code: m ? Number(m[1]) : -999 };
}

const PROMPT = 'Enter the number of your choice';

describe('main menu in a real terminal', () => {
	it('Ctrl+C at the menu: "Stopped — you pressed Ctrl+C", exit 130, no "fatal"', () => {
		const { out, code } = drive([[PROMPT, '\x03']]);
		expect(out).toContain('Stopped — you pressed Ctrl+C');
		expect(out).not.toMatch(/fatal/);
		expect(code).toBe(130);
		// The offline-notify tip claims nothing that is not kept (v1.21.18
		// review: "shown as not tested" — it is only said when it is saved),
		// and says per app what tests it (not "each is tested by a test note":
		// Telegram sends none, email cannot skip it).
		expect(out).not.toMatch(/shown as not tested|marked not tested/);
		expect(out).not.toMatch(/each is tested by a test note/);
		expect(out).toContain('Telegram has its bot token checked by Telegram');
		expect(out).toContain('Session is tested only by a test note, which you may skip');
	});

	it('Ctrl+D at the menu: "the input ended", exit 130, no "fatal"', () => {
		const { out, code } = drive([[PROMPT, '\x04']]);
		expect(out).toContain('Stopped — the input ended');
		expect(out).not.toMatch(/fatal/);
		expect(code).toBe(130);
	});

	it('without sudo: the menu says so, and a privileged pick names the sudo command', () => {
		// Read "Status dashboard"'s number off the menu, then pick it.
		const listing = drive([[PROMPT, '\x03']], { asNobody: true }).out;
		const num = /(\d+)\. Status dashboard/.exec(listing)?.[1];
		expect(num).toBeDefined();
		expect(listing).toContain('You started this without sudo');
		expect(listing).toMatch(/Status dashboard {2}\(needs sudo\)/);
		const pick = drive([[PROMPT, `${num}\r`]], { asNobody: true });
		expect(pick.out).toContain('needs administrator rights on this server');
		expect(pick.out).toContain('sudo morphit-ops status');
		expect(pick.out).not.toMatch(/fatal|EACCES/);
		expect(pick.code).toBe(1);
	});
});

describe('the "(needs sudo)" tag', () => {
	it('is shown without sudo and hidden when the menu already runs as root', () => {
		expect(needsRoot('status')).toBe(true);
		expect(rootTag('status', false)).toContain('needs sudo');
		expect(rootTag('status', true)).toBe('');
		expect(rootTag('health', false)).toBe('');
	});
});

describe("this server's relay account", () => {
	const KEYS = [
		'MORPHIT_OPS_RELAY_ACCOUNT',
		'MORPHIT_RELAY_ACCOUNT',
		'MORPHIT_INDEXER_RELAY_ACCOUNT',
		'MORPHIT_OPS_THRESHOLD_RELAY_BALANCE_WARN'
	];
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const k of KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("is the one morphit.env names (the relay's own setting)", () => {
		process.env.MORPHIT_RELAY_ACCOUNT = 'other-relay';
		expect(relayAccountFromEnv()).toBe('other-relay');
	});
	it('a CLI-specific setting still wins; with none, it is unknown — never morphit.io\u2019s relay', () => {
		process.env.MORPHIT_RELAY_ACCOUNT = 'other-relay';
		process.env.MORPHIT_OPS_RELAY_ACCOUNT = 'ops-choice';
		expect(relayAccountFromEnv()).toBe('ops-choice');
		delete process.env.MORPHIT_OPS_RELAY_ACCOUNT;
		delete process.env.MORPHIT_RELAY_ACCOUNT;
		// v1.21.18 review: it fell back to "morphit-relay" (morphit.io's relay),
		// which every other server then showed and graded as its own.
		expect(relayAccountFromEnv()).toBeNull();
		process.env.MORPHIT_INDEXER_RELAY_ACCOUNT = 'indexer-named';
		expect(relayAccountFromEnv()).toBe('indexer-named');
	});
	it('thresholds load without a database address', () => {
		process.env.MORPHIT_OPS_THRESHOLD_RELAY_BALANCE_WARN = '250';
		expect(loadThresholds().relayBalance.warn).toBe(250);
	});
});

describe("the menu reads this server's settings before its markers", () => {
	it('loadInstanceEnv runs before gatherMenuAnnotations in the bare-menu path', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(resolve(CLI_DIR, 'src', 'main.ts'), 'utf8');
		const menuStart = src.indexOf('if (args.subcommand === null) {');
		const annotations = src.indexOf('await gatherMenuAnnotations(', menuStart);
		const envLoad = src.indexOf('loadInstanceEnv(defaultRepoRoot())', menuStart);
		expect(menuStart).toBeGreaterThan(-1);
		expect(annotations).toBeGreaterThan(menuStart);
		// Without it the "relay balance low" marker graded @morphit-relay on every server.
		expect(envLoad).toBeGreaterThan(menuStart);
		expect(envLoad).toBeLessThan(annotations);
	});
});

describe('a database command on a server with no Morphit install', () => {
	it('says to install first, not which settings to set', async () => {
		const { notInstalledMessage } = await import('../src/lib/notInstalled.ts');
		const err = new Error('No database URL configured.  Set one of:\n  MORPHIT_OPS_DATABASE_URL');
		const none = (): boolean => false;
		expect(notInstalledMessage(err, '/opt/morphit', none)).toContain(
			'Morphit is not installed here'
		);
		expect(notInstalledMessage(err, '/opt/morphit', none)).toContain('sudo morphit-ops');
		// Installed (its settings exist), run as root: keep the original message.
		const installed = (p: string): boolean => p === '/etc/morphit/indexer.env';
		expect(notInstalledMessage(err, '/opt/morphit', installed, { isRoot: true })).toBeNull();
		// …run without sudo, settings it cannot read: the exact sudo command.
		expect(
			notInstalledMessage(err, '/opt/morphit', installed, {
				isRoot: false,
				readable: () => false,
				argv: ['abuse', '--since', '7d']
			})
		).toContain('Run it with sudo: sudo morphit-ops abuse --since 7d');
		// …without sudo but readable settings that name no database: unchanged.
		expect(
			notInstalledMessage(err, '/opt/morphit', installed, { isRoot: false, readable: () => true })
		).toBeNull();
		expect(notInstalledMessage(new Error('other'), '/opt/morphit', none)).toBeNull();
	});

	it('a database view run on such a server says so (a real run, as root)', () => {
		// A stand-in checkout with no settings at all, run from inside it.
		const dir = mkdtempSync(join(tmpdir(), 'menu-noinstall-'));
		writeFileSync(join(dir, 'package.json'), '{"name":"stand-in","private":true,"workspaces":[]}');
		const r = spawnSync(TSX, [resolve(CLI_DIR, 'src', 'main.ts'), 'abuse'], {
			cwd: dir,
			encoding: 'utf8',
			timeout: 90_000,
			env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TSX_DISABLE_CACHE: '1' }
		});
		const out = `${r.stdout}${r.stderr}`;
		if (existsSync('/etc/morphit/indexer.env')) return; // this machine has an install
		expect(out).toContain('Morphit is not installed here');
		expect(out).not.toContain('Set one of');
	}, 120_000);
});
