/**
 * `morphit-ops install` (menu 1) from an installed node, and how it stops.
 *
 * Review, 2026-10-29:
 *  - the installed launcher runs the CLI from /opt/morphit/apps/ops-cli, and
 *    Install took that folder as the install: after every question it looked
 *    for …/apps/ops-cli/ops/ansible/playbook.yml (missing), with the keystore
 *    already rewritten;
 *  - the full guided install never noticed the server already runs Morphit
 *    (`init` does);
 *  - a closed input (Ctrl+D) at its first question printed "you pressed
 *    Ctrl+C", then saved answers and a NEW database password, though nothing
 *    had been asked;
 *  - "Configure only" ignored fast-sync's exit code and ended with "Start/enable
 *    your services (see docs…)".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

const q = {
	choices: [] as Array<number | 'ctrl-d' | 'default'>,
	yesNo: [] as Array<boolean | 'ctrl-c'>
};
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = await orig<typeof import('../src/init/prompt.ts')>();
	return {
		...real,
		askChoice: async (_q: string, _c: readonly string[], def?: number) => {
			const a = q.choices.shift();
			if (a === 'ctrl-d') throw real.inputEndedError();
			if (a === undefined || a === 'default') return def ?? 0;
			return a;
		},
		askYesNo: async (_q: string, def: boolean) => {
			const a = q.yesNo.shift();
			if (a === 'ctrl-c')
				throw Object.assign(new Error('Aborted with Ctrl+C'), {
					name: 'AbortError',
					code: 'ABORT_ERR'
				});
			return a ?? def;
		}
	};
});

const { runInstall } = await import('../src/commands/install.ts');
const { describeInstallError, noteInstallStage } = await import('../src/init/assembleInstall.ts');

let dir = '';
let out = '';
const HOME = process.env.HOME;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'install-entry-'));
	// No answers saved from an earlier run.
	process.env.HOME = dir;
	q.choices = [];
	q.yesNo = [];
	out = '';
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += `${a.map(String).join(' ')}\n`;
	});
});
afterEach(() => {
	process.env.HOME = HOME;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

const ctx = { flags: {}, positional: [], colorEnabled: false };
const quiet = { offerPathSymlink: async () => undefined, finishInstall: () => undefined };

describe('the guided install from an installed node', () => {
	it('run from apps/ops-cli (the launcher), it installs from the install root', async () => {
		expect(process.cwd()).toBe(join(REPO, 'apps', 'ops-cli'));
		q.choices = [0];
		const seen: string[] = [];
		await runInstall(ctx, {
			installedRoot: join(dir, 'opt-morphit'),
			runAnsibleInstall: async (o) => {
				seen.push(o.repoRoot);
				return 1;
			},
			...quiet
		});
		expect(seen).toEqual([REPO]);
	});

	it('a server that already runs Morphit: says so, and the default changes nothing', async () => {
		mkdirSync(join(dir, 'opt-morphit'));
		writeFileSync(join(dir, 'opt-morphit', 'morphit.config.env'), 'MORPHIT_INSTANCE_NAME=Alice\n');
		q.choices = [0, 'default'];
		let installs = 0;
		const code = await runInstall(ctx, {
			installedRoot: join(dir, 'opt-morphit'),
			runAnsibleInstall: async () => {
				installs++;
				return 0;
			},
			...quiet
		});
		expect(code).toBe(0);
		expect(installs).toBe(0);
		expect(out).toContain('This server already runs Morphit');
		expect(out).toContain(join(dir, 'opt-morphit', 'morphit.config.env'));
		expect(out).toContain('Nothing was changed.');
	});

	it('"Edit" opens the settings of the node found, not the folder the install started from', async () => {
		// The release was unpacked in one folder; the node is installed in another.
		const installed = join(dir, 'opt-morphit');
		mkdirSync(installed);
		writeFileSync(join(installed, 'morphit.config.env'), 'MORPHIT_INSTANCE_NAME=Alice\n');
		const unpacked = join(dir, 'Downloads', 'morphit');
		mkdirSync(unpacked, { recursive: true });
		q.choices = [0, 0];
		const opened: string[] = [];
		await runInstall(ctx, {
			repoRoot: unpacked,
			installedRoot: installed,
			runEdit: async (c) => {
				const out = c.flags.out ?? '(the default install folder)';
				opened.push(out);
				// What edit reads there: the settings it was offered for.
				return existsSync(join(out, 'morphit.config.env')) ? 0 : 1;
			},
			runAnsibleInstall: async () => 1,
			...quiet
		});
		expect(opened).toEqual([installed]);
	});

	it('…and installing again from scratch needs a second yes', async () => {
		mkdirSync(join(dir, 'opt-morphit'));
		writeFileSync(join(dir, 'opt-morphit', 'morphit.config.env'), '\n');
		let installs = 0;
		const deps = {
			installedRoot: join(dir, 'opt-morphit'),
			runAnsibleInstall: async () => {
				installs++;
				return 1;
			},
			...quiet
		};
		q.choices = [0, 1];
		q.yesNo = [false];
		await runInstall(ctx, deps);
		expect(installs).toBe(0);
		q.choices = [0, 1];
		q.yesNo = [true];
		await runInstall(ctx, deps);
		expect(installs).toBe(1);
	});
});

describe('how the install says it stopped', () => {
	it('the input closed at the first question: said as such, and nothing that does not apply', async () => {
		q.choices = ['ctrl-d'];
		const err = await runInstall(ctx, quiet).then(
			() => null,
			(e: unknown) => e
		);
		expect(err).not.toBeNull();
		const msg = describeInstallError(err, false, 'sudo morphit-ops install');
		expect(msg).toMatch(/the input ended \(Ctrl\+D/);
		expect(msg).not.toMatch(/Ctrl\+C/);
		expect(msg).not.toMatch(/database password/i);
		expect(msg).not.toMatch(/reuse the answers/);
		expect(msg).toContain('Nothing was installed or changed on this server.');
		expect(msg).toContain('sudo morphit-ops install');
	});

	it('"Configure only", stopped after the setup wizard wrote the settings: never "nothing was changed"', async () => {
		q.choices = [1];
		q.yesNo = [true, 'ctrl-c']; // continue to the wizard; Ctrl+C at "Fast-sync this node…?"
		const err = await runInstall(ctx, {
			repoRoot: dir,
			probePresent: async () => true,
			runInit: async () => 0,
			...quiet
		}).then(
			() => null,
			(e: unknown) => e
		);
		expect(err).not.toBeNull();
		const msg = describeInstallError(err, false, 'sudo morphit-ops install');
		expect(msg).toContain('you pressed Ctrl+C');
		expect(msg).toContain(
			`The setup wizard saved your settings in ${REPO} (morphit.config.env, morphit.env and your relay key); nothing else was installed.`
		);
		expect(msg).not.toContain('Nothing was installed or changed');
	});

	it('the guided install, stopped after it saved the relay key: says where, never "nothing was changed"', () => {
		noteInstallStage('none');
		noteInstallStage('keystore-written', {
			keystore: ['/etc/morphit/relay.keystore', '/etc/morphit/relay_passphrase.cred']
		});
		noteInstallStage('password-shown');
		const ctrlC = Object.assign(new Error('Aborted with Ctrl+C'), { name: 'AbortError' });
		const msg = describeInstallError(ctrlC, false, 'sudo morphit-ops install', {
			answersSaved: true
		});
		expect(msg).toContain(
			'Your relay key was saved to /etc/morphit/relay.keystore (and its unlock passphrase to /etc/morphit/relay_passphrase.cred); nothing else was installed.'
		);
		expect(msg).not.toContain('Nothing was installed or changed');
		noteInstallStage('none');
	});

	it('no answer in time on an open pipe: said as that, never "the input ended"', () => {
		const timedOut = Object.assign(new Error('no answer'), {
			name: 'AbortError',
			code: 'ABORT_ERR',
			noAnswerWithinMs: 20_000
		});
		const msg = describeInstallError(timedOut, false, 'sudo morphit-ops install', {
			stage: 'questions',
			answersSaved: false
		});
		expect(msg).toContain('Stopped — no answer came within 20 seconds');
		expect(msg).not.toMatch(/input ended|Ctrl\+C/);
	});

	it('Ctrl+C after the password was shown: the NEW-password note, and saved answers when there are some', () => {
		const ctrlC = Object.assign(new Error('Aborted with Ctrl+C'), { name: 'AbortError' });
		const msg = describeInstallError(ctrlC, false, 'sudo morphit-ops install', {
			stage: 'password-shown',
			answersSaved: true
		});
		expect(msg).toContain('you pressed Ctrl+C');
		expect(msg).toMatch(/NEW database password/);
		expect(msg).toMatch(/reuse the answers/);
	});
});

describe('"Configure only" after its fast-sync', () => {
	async function configureOnly(fastSyncRc: number, systemd: boolean): Promise<void> {
		if (systemd) {
			mkdirSync(join(dir, 'etc', 'systemd', 'system'), { recursive: true });
			writeFileSync(join(dir, 'etc', 'systemd', 'system', 'morphit-indexer.service'), '');
		}
		q.choices = [1];
		await runInstall(ctx, {
			root: dir,
			probePresent: async () => true,
			runInit: async () => 0,
			runHarden: async () => 0,
			fastSync: () => fastSyncRc,
			...quiet
		});
	}

	it('a database that must not be served: no "start your services"', async () => {
		await configureOnly(4, true);
		expect(out).toContain('do NOT start the');
		expect(out).toContain('Do not start the indexer yet');
		expect(out).not.toMatch(/systemctl enable --now morphit-indexer|Start\/enable your services/);
	});

	it('a fast-sync that did not complete: said, with the command to try again', async () => {
		await configureOnly(1, true);
		expect(out).toContain('Fast-sync did not complete; the database is as it was.');
		expect(out).toContain('sudo morphit-ops fast-sync');
	});

	it('a good one on a systemd node: the exact commands, indexer first', async () => {
		await configureOnly(0, true);
		const idx = out.indexOf('sudo systemctl enable --now morphit-indexer');
		expect(idx).toBeGreaterThan(-1);
		expect(out.indexOf('sudo systemctl enable --now morphit-relay')).toBeGreaterThan(idx);
		expect(out).not.toContain('see docs/RUN-A-MORPHIT-NODE.md');
	});

	it('without systemd units: how to start each, by its full path', async () => {
		await configureOnly(0, false);
		expect(out).toContain(`cd ${join(REPO, 'apps', 'indexer')} && npm start`);
		expect(out).toContain(`cd ${join(REPO, 'apps', 'relay')} && npm start`);
	});
});
