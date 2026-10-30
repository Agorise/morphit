/**
 * `morphit-ops bunkerweb` (menu: Web firewall), review 2026-10-29:
 *  - M12: a `docker ps` that failed (the daemon down) read as "no BunkerWeb
 *    containers" → "BunkerWeb is not running … Install + start now? [Y/n]",
 *    default yes, on a server whose BunkerWeb was fine;
 *  - its manual steps were relative (`ops/bunkerweb`), nested themselves into
 *    /etc/bunkerweb/bunkerweb when that folder existed, said to "edit" a
 *    bunkerweb.env that was never made, had no certificate step and no sudo;
 *  - "Stop: … docker compose down" did not say it takes the website down.
 * A stand-in `docker` on PATH plays the server.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bunkerwebCommands, cpNoClobberFlag, runBunkerWeb } from '../src/commands/bunkerweb.ts';

const REPO = new URL('../../../', import.meta.url).pathname;

let out = '';
beforeEach(() => {
	out = '';
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** PATH with a `docker` that runs `script` (sh). */
function fakeDocker(script: string): string {
	const bin = mkdtempSync(join(tmpdir(), 'morphit-fakedocker-'));
	writeFileSync(join(bin, 'docker'), `#!/bin/sh\n${script}\n`);
	chmodSync(join(bin, 'docker'), 0o755);
	return `${bin}:${process.env.PATH ?? ''}`;
}

describe('bunkerweb', () => {
	it('Docker not answering: says so, gives the command, offers no install', async () => {
		vi.stubEnv(
			'PATH',
			fakeDocker(
				'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1'
			)
		);
		const code = await runBunkerWeb({ flags: {}, positional: [], colorEnabled: false });
		expect(code).toBe(1);
		expect(out).toMatch(/Docker is not answering on this server/);
		expect(out).toContain('sudo systemctl status docker');
		expect(out).not.toMatch(/BunkerWeb is not running/);
		expect(out).not.toMatch(/Install \+ start BunkerWeb now/);
		expect(out).not.toMatch(/Bring BunkerWeb up/);
	});

	it('running: the stop command says it takes the website offline', async () => {
		vi.stubEnv(
			'PATH',
			fakeDocker(
				'case "$1" in\n' +
					'ps) printf "bunkerweb\\tbunkerity/bunkerweb:1.5.10\\t0.0.0.0:443->8443/tcp\\tUp 2 hours\\tbunkerweb\\tbunkerweb\\nbunkerweb-scheduler\\tbunkerity/bunkerweb-scheduler:1.5.10\\t\\tUp 2 hours\\tbunkerweb\\tbw-scheduler\\n";;\n' +
					'inspect) case "$*" in *--format*) echo "running|healthy";; *) echo "[]";; esac;;\n' +
					'esac'
			)
		);
		const code = await runBunkerWeb({ flags: {}, positional: [], colorEnabled: false });
		expect(code).toBe(0);
		expect(out).toMatch(/sudo docker compose down\s+\(this takes your website offline/);
	});
});

describe('the manual steps', () => {
	it('copy into an existing /etc/bunkerweb without nesting or overwriting, and make bunkerweb.env', () => {
		const cmds = bunkerwebCommands(REPO.replace(/\/$/, ''), 'trade.alice.net');
		const etc = join(mkdtempSync(join(tmpdir(), 'morphit-bwsteps-')), 'etc-bunkerweb');
		mkdirSync(etc);
		writeFileSync(join(etc, 'bunkerweb.env'), 'SERVER_NAME=trade.alice.net\nEDITED=yes\n');
		const copies = cmds.bringUp.filter((l) => /^sudo (mkdir|cp) /.test(l));
		expect(copies.length).toBeGreaterThan(1);
		for (const c of copies) {
			const r = spawnSync('sh', ['-c', c.replace(/^sudo /, '').replaceAll('/etc/bunkerweb', etc)], {
				cwd: tmpdir(), // absolute paths: works from anywhere
				encoding: 'utf8'
			});
			expect(r.status, `${c}: ${r.stderr}`).toBe(0);
			// No warning from this server's cp (Ubuntu 24.04's warns on every `cp -n`).
			expect(r.stderr, c).toBe('');
		}
		expect(existsSync(join(etc, 'bunkerweb'))).toBe(false);
		expect(existsSync(join(etc, 'docker-compose.yml'))).toBe(true);
		expect(readFileSync(join(etc, 'bunkerweb.env'), 'utf8')).toContain('EDITED=yes');
	});

	it('never-overwrite copy: --update=none where cp has it, -n on an older cp (22.04 refuses --update=none)', () => {
		const newer =
			'  -n, --no-clobber   (deprecated) silently skip existing files.\n' +
			'  --update[=UPDATE]  control which existing files are updated;\n' +
			'                     UPDATE={all,none,none-fail,older(default)}.\n';
		const older =
			'  -n, --no-clobber   do not overwrite an existing file\n' +
			'  -u, --update       copy only when the SOURCE file is newer\n';
		const withNewer = bunkerwebCommands('/opt/morphit', 'trade.alice.net', cpNoClobberFlag(newer));
		expect(withNewer.bringUp).toContain(
			'sudo cp -r --update=none /opt/morphit/ops/bunkerweb/. /etc/bunkerweb/'
		);
		expect(withNewer.bringUp.join('\n')).not.toMatch(/cp (-r )?-n\b|cp -rn/);
		const withOlder = bunkerwebCommands('/opt/morphit', 'trade.alice.net', cpNoClobberFlag(older));
		expect(withOlder.bringUp).toContain(
			'sudo cp -r -n /opt/morphit/ops/bunkerweb/. /etc/bunkerweb/'
		);
		expect(withOlder.bringUp.join('\n')).not.toMatch(/--update=none/);
	});

	it('give the certificate step, and sudo for every docker command', () => {
		const cmds = bunkerwebCommands('/opt/morphit', 'trade.alice.net');
		expect(cmds.bringUp.join('\n')).toMatch(
			/sudo certbot certonly --standalone -d trade\.alice\.net/
		);
		for (const l of [...cmds.bringUp, cmds.down, cmds.status])
			if (/docker compose/.test(l)) expect(l).toMatch(/sudo docker compose/);
		// a fresh /etc/bunkerweb: bunkerweb.env is made from its example
		const etc = join(mkdtempSync(join(tmpdir(), 'morphit-bwsteps-')), 'etc-bunkerweb');
		for (const c of bunkerwebCommands(REPO.replace(/\/$/, ''), null).bringUp.filter((l) =>
			/^sudo (mkdir|cp) /.test(l)
		))
			spawnSync('sh', ['-c', c.replace(/^sudo /, '').replaceAll('/etc/bunkerweb', etc)]);
		expect(existsSync(join(etc, 'bunkerweb.env'))).toBe(true);
	});
});
